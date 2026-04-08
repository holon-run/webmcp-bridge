/**
 * This module persists profile-scoped overlay tool definitions, resolves override ownership, and exports draft adapters.
 * It depends on filesystem APIs plus page-context evaluation so local-mcp can evolve draft tools without widening the shared gateway contract.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@webmcp-bridge/core";
import type { WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import type { Page } from "playwright";

const OVERLAY_DIR = ".webmcp-bridge/overlays";
const OVERLAY_EXPORT_DIR = ".webmcp-bridge/exports";
const OVERLAY_FILE_SUFFIX = ".json";
const OVERLAY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const OVERLAY_EXPORT_PACKAGE_VERSION = "^0.7.0";

type OverlayAnnotationRecord = {
  readOnlyHint?: boolean;
};

export type OverlayActivation = "namespaced" | "override";

export type OverlayToolRecord = {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: OverlayAnnotationRecord;
  script: string;
};

export type OverlayRecord = {
  id: string;
  siteId: string;
  enabled: boolean;
  activation: OverlayActivation;
  description?: string;
  tools: OverlayToolRecord[];
  createdAt: string;
  updatedAt: string;
};

export type InstallOverlayOptions = {
  id: string;
  description?: string;
  enabled?: boolean;
  activation?: OverlayActivation;
  tools: OverlayToolRecord[];
};

export type UpdateOverlayOptions = {
  id: string;
  description?: string;
  enabled?: boolean;
  activation?: OverlayActivation;
  tools?: OverlayToolRecord[];
};

export type OverlaySummaryRecord = OverlayRecord & {
  aliasPrefix: string;
  toolNames: string[];
  shadowedTools: string[];
};

export type OverlayListResult = {
  overlays: OverlaySummaryRecord[];
  persistence: {
    available: boolean;
    reason?: "managed_profile_required";
    profilePath?: string;
  };
};

export type ExportOverlayOptions = {
  id: string;
  targetUrl: string;
  siteDisplayName: string;
  hostPatterns: string[];
};

export type ExportOverlayResult = {
  overlay: OverlayRecord;
  format: "adapter-draft";
  outputDir: string;
  entryFile: string;
  files: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function timestamp(): string {
  return new Date().toISOString();
}

function overlayDirectory(profilePath: string): string {
  return join(profilePath, OVERLAY_DIR);
}

function overlayFilePath(profilePath: string, overlayId: string): string {
  return join(overlayDirectory(profilePath), `${overlayId}${OVERLAY_FILE_SUFFIX}`);
}

function overlayExportDirectory(profilePath: string, overlayId: string): string {
  return join(profilePath, OVERLAY_EXPORT_DIR, overlayId);
}

function assertOverlayId(id: string): void {
  if (!OVERLAY_ID_PATTERN.test(id)) {
    throw new Error(
      "INVALID_ARGUMENT: overlay id must match ^[a-z0-9][a-z0-9_-]*$ so it can be stored and exposed as overlay.<id>.*",
    );
  }
}

function assertToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name) || name.startsWith("bridge.") || name.startsWith("overlay.")) {
    throw new Error(
      "INVALID_ARGUMENT: overlay tool name must be a non-empty MCP-style name and must not start with bridge. or overlay.",
    );
  }
}

function normalizeActivation(value: unknown): OverlayActivation {
  if (value === undefined) {
    return "namespaced";
  }
  if (value === "namespaced" || value === "override") {
    return value;
  }
  throw new Error("OVERLAY_CONTRACT_ERROR: overlay activation must be namespaced or override");
}

function normalizeToolRecord(tool: unknown): OverlayToolRecord {
  if (!isRecord(tool)) {
    throw new Error("OVERLAY_CONTRACT_ERROR: overlay tool entries must be objects");
  }
  if (typeof tool.name !== "string") {
    throw new Error("OVERLAY_CONTRACT_ERROR: overlay tool name must be a string");
  }
  if (typeof tool.script !== "string") {
    throw new Error(`OVERLAY_CONTRACT_ERROR: overlay tool ${tool.name} script must be a string`);
  }
  const name = tool.name.trim();
  assertToolName(name);
  const script = tool.script.trim();
  if (!script) {
    throw new Error(`INVALID_ARGUMENT: overlay tool ${name} requires a non-empty script`);
  }
  const output: OverlayToolRecord = {
    name,
    script,
  };
  if (typeof tool.description === "string" && tool.description.trim()) {
    output.description = tool.description.trim();
  }
  if (tool.inputSchema !== undefined) {
    output.inputSchema = cloneJsonValue(tool.inputSchema as JsonValue);
  }
  if (tool.annotations !== undefined) {
    if (!isRecord(tool.annotations)) {
      throw new Error(`OVERLAY_CONTRACT_ERROR: overlay tool ${name} annotations must be an object`);
    }
    const readOnlyHint = tool.annotations.readOnlyHint;
    if (readOnlyHint !== undefined && typeof readOnlyHint !== "boolean") {
      throw new Error(`OVERLAY_CONTRACT_ERROR: overlay tool ${name} annotations.readOnlyHint must be a boolean`);
    }
    output.annotations = {
      ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
    };
  }
  return output;
}

function normalizeOverlayRecord(value: unknown, siteId: string): OverlayRecord {
  if (!isRecord(value)) {
    throw new Error("OVERLAY_CONTRACT_ERROR: overlay file must be a JSON object");
  }
  if (typeof value.id !== "string") {
    throw new Error("OVERLAY_CONTRACT_ERROR: overlay id must be a string");
  }
  assertOverlayId(value.id);
  const rawSiteId = typeof value.siteId === "string" ? value.siteId.trim() : "";
  if (!rawSiteId) {
    throw new Error("OVERLAY_CONTRACT_ERROR: overlay siteId must be a non-empty string");
  }
  if (rawSiteId !== siteId) {
    throw new Error(`OVERLAY_SITE_MISMATCH: overlay ${value.id} targets ${rawSiteId}, expected ${siteId}`);
  }
  if (!Array.isArray(value.tools)) {
    throw new Error(`OVERLAY_CONTRACT_ERROR: overlay ${value.id} must define a tools array`);
  }
  const normalizedTools = value.tools.map((tool) => normalizeToolRecord(tool as OverlayToolRecord));
  const createdAt = typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : timestamp();
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : createdAt;
  const output: OverlayRecord = {
    id: value.id,
    siteId: rawSiteId,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    activation: normalizeActivation(value.activation),
    tools: normalizedTools,
    createdAt,
    updatedAt,
  };
  if (typeof value.description === "string" && value.description.trim()) {
    output.description = value.description.trim();
  }
  return output;
}

async function ensureOverlayDirectory(profilePath: string): Promise<string> {
  const dirPath = overlayDirectory(profilePath);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function persistOverlay(profilePath: string, overlay: OverlayRecord): Promise<void> {
  await ensureOverlayDirectory(profilePath);
  const filePath = overlayFilePath(profilePath, overlay.id);
  await writeFile(filePath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
}

async function executePageFunction(page: Page, script: string, args: JsonValue): Promise<JsonValue> {
  const evaluatePage = page as unknown as {
    evaluate: (
      pageFunction: (payload: { scriptSource: string; scriptArgs: JsonValue }) => Promise<string>,
      payload: { scriptSource: string; scriptArgs: JsonValue },
    ) => Promise<string>;
  };
  const serialized = await evaluatePage.evaluate(
    async ({ scriptSource, scriptArgs }) => {
      const evaluator = globalThis.eval as (source: string) => unknown;
      const candidate = evaluator(`(${scriptSource})`);
      if (typeof candidate !== "function") {
        throw new Error("script must evaluate to a function");
      }
      const value = await candidate(scriptArgs);
      const json = JSON.stringify(value);
      if (json === undefined) {
        throw new Error("script result must be JSON-serializable");
      }
      return json;
    },
    {
      scriptSource: script,
      scriptArgs: args,
    },
  );
  return JSON.parse(serialized) as JsonValue;
}

export async function evaluateDebugScript(page: Page, script: string, args: JsonValue): Promise<JsonValue> {
  const normalizedScript = script.trim();
  if (!normalizedScript) {
    throw new Error("INVALID_ARGUMENT: script must be a non-empty string");
  }
  try {
    return await executePageFunction(page, normalizedScript, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DEBUG_EVAL_FAILED: ${message}`);
  }
}

export async function evaluateOverlayTool(
  page: Page,
  overlay: OverlayRecord,
  tool: OverlayToolRecord,
  input: Record<string, unknown>,
): Promise<JsonValue> {
  try {
    return await executePageFunction(page, tool.script, input as JsonValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OVERLAY_TOOL_FAILED: overlay ${overlay.id} tool ${tool.name} failed: ${message}`);
  }
}

function toAliasToolDefinitions(overlays: ReadonlyArray<OverlayRecord>): WebMcpToolDefinition[] {
  return overlays.flatMap((overlay) =>
    overlay.enabled
      ? overlay.tools.map((tool) => ({
          name: `overlay.${overlay.id}.${tool.name}`,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : { inputSchema: { type: "object" } }),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        }))
      : [],
  );
}

function overlayAliasPrefix(overlayId: string): string {
  return `overlay.${overlayId}`;
}

function toAliasToolDefinition(overlayId: string, tool: OverlayToolRecord): WebMcpToolDefinition {
  return {
    name: `${overlayAliasPrefix(overlayId)}.${tool.name}`,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : { inputSchema: { type: "object" } }),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

function toCanonicalToolDefinition(tool: OverlayToolRecord): WebMcpToolDefinition {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : { inputSchema: { type: "object" } }),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

function toExportSafeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "draft";
}

function toPackageName(siteId: string, overlayId: string): string {
  return `webmcp-overlay-${toExportSafeIdentifier(siteId).toLowerCase()}-${toExportSafeIdentifier(overlayId).toLowerCase()}-draft`;
}

function toDisplayName(siteDisplayName: string, overlayId: string): string {
  return `${siteDisplayName} ${overlayId} Draft`;
}

function buildAdapterDraftSource(
  overlay: OverlayRecord,
  targetUrl: string,
  siteDisplayName: string,
  hostPatterns: string[],
): string {
  const toolDefinitions = overlay.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : { inputSchema: { type: "object" } }),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  }));
  const toolScripts = Object.fromEntries(overlay.tools.map((tool) => [tool.name, tool.script]));
  const toolNames = overlay.tools.map((tool) => tool.name);
  return `/**
 * This module provides an exported adapter draft generated from a persisted local-mcp overlay.
 * It depends on the playwright adapter contract so the draft can be reviewed locally and promoted into a formal adapter package.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { AdapterManifest, SiteAdapter, WebMcpToolDefinition } from "@webmcp-bridge/playwright";

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = ${JSON.stringify(toolDefinitions, null, 2)} as WebMcpToolDefinition[];
const TOOL_SCRIPTS: Record<string, string> = ${JSON.stringify(toolScripts, null, 2)};

function errorResult(code: string, message: string): JsonValue {
  return {
    error: {
      code,
      message,
    },
  };
}

async function executePageFunction(
  page: { evaluate: (fn: (payload: { scriptSource: string; scriptArgs: JsonValue }) => Promise<string>, payload: { scriptSource: string; scriptArgs: JsonValue }) => Promise<string> },
  scriptSource: string,
  scriptArgs: JsonValue,
): Promise<JsonValue> {
  const serialized = await page.evaluate(
    async ({ scriptSource, scriptArgs }) => {
      const evaluator = globalThis.eval as (source: string) => unknown;
      const candidate = evaluator(\`(\${scriptSource})\`);
      if (typeof candidate !== "function") {
        throw new Error("script must evaluate to a function");
      }
      const value = await candidate(scriptArgs);
      const json = JSON.stringify(value);
      if (json === undefined) {
        throw new Error("script result must be JSON-serializable");
      }
      return json;
    },
    { scriptSource, scriptArgs },
  );
  return JSON.parse(serialized) as JsonValue;
}

export const manifest: AdapterManifest = {
  id: ${JSON.stringify(overlay.siteId)},
  displayName: ${JSON.stringify(toDisplayName(siteDisplayName, overlay.id))},
  version: "0.1.0",
  bridgeApiVersion: "1.0.0",
  defaultUrl: ${JSON.stringify(targetUrl)},
  hostPatterns: ${JSON.stringify(hostPatterns)},
};

export function createAdapter(): SiteAdapter {
  return {
    name: ${JSON.stringify(`overlay-${overlay.id}-draft`)},
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }, context) => {
      if (!${JSON.stringify(toolNames)}.includes(name)) {
        return errorResult("TOOL_NOT_FOUND", \`unknown tool: \${name}\`);
      }
      const script = TOOL_SCRIPTS[name];
      try {
        return await executePageFunction(context.page, script, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("OVERLAY_DRAFT_TOOL_FAILED", \`overlay draft tool \${name} failed: \${message}\`);
      }
    },
  };
}
`;
}

function buildAdapterDraftReadme(overlay: OverlayRecord, outputDir: string): string {
  return `# ${overlay.id} adapter draft

This directory was generated from the persisted overlay \`${overlay.id}\`.

## What it contains

- \`src/index.ts\`: adapter draft source
- \`package.json\`: minimal package metadata
- \`tsconfig.json\`: local build config

## Notes

- This is a local draft artifact, not a published adapter package.
- The source keeps the current overlay tool schemas and page-context scripts.
- Review and refine the generated draft before promoting it into a formal adapter.

Generated output directory: \`${outputDir}\`
`;
}

export class OverlayStore {
  private overlays = new Map<string, OverlayRecord>();

  constructor(
    private readonly siteId: string,
    private readonly profilePath?: string,
  ) {}

  private validateOverrideConflicts(overlays: ReadonlyArray<OverlayRecord>): void {
    const owners = new Map<string, string>();
    for (const overlay of overlays) {
      if (!overlay.enabled || overlay.activation !== "override") {
        continue;
      }
      for (const tool of overlay.tools) {
        const owner = owners.get(tool.name);
        if (owner && owner !== overlay.id) {
          throw new Error(
            `OVERLAY_OVERRIDE_CONFLICT: tool ${tool.name} is already overridden by overlay ${owner}`,
          );
        }
        owners.set(tool.name, overlay.id);
      }
    }
  }

  private snapshot(overrides?: Map<string, OverlayRecord>): OverlayRecord[] {
    return Array.from((overrides ?? this.overlays).values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  private commit(overlays: Map<string, OverlayRecord>): void {
    this.validateOverrideConflicts(this.snapshot(overlays));
    this.overlays = overlays;
  }

  private summarizeOverlays(baseToolNames: ReadonlyArray<string>): OverlaySummaryRecord[] {
    const baseToolSet = new Set(baseToolNames);
    return this.snapshot().map((overlay) => ({
      ...cloneJsonValue(overlay),
      aliasPrefix: overlayAliasPrefix(overlay.id),
      toolNames: overlay.tools.map((tool) => tool.name),
      shadowedTools:
        overlay.enabled && overlay.activation === "override"
          ? overlay.tools.map((tool) => tool.name).filter((name) => baseToolSet.has(name))
          : [],
    }));
  }

  async load(): Promise<void> {
    const nextOverlays = new Map<string, OverlayRecord>();
    if (!this.profilePath) {
      this.overlays.clear();
      return;
    }
    const dirPath = overlayDirectory(this.profilePath);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        return;
      }
      throw error;
    }
    const fileNames = entries.filter((entry) => entry.endsWith(OVERLAY_FILE_SUFFIX)).sort();
    for (const entry of fileNames) {
      const raw = await readFile(join(dirPath, entry), "utf8");
      const overlay = normalizeOverlayRecord(JSON.parse(raw) as unknown, this.siteId);
      nextOverlays.set(overlay.id, overlay);
    }
    this.commit(nextOverlays);
  }

  list(baseToolNames: ReadonlyArray<string> = []): OverlayListResult {
    const overlays = this.summarizeOverlays(baseToolNames);
    if (!this.profilePath) {
      return {
        overlays,
        persistence: {
          available: false,
          reason: "managed_profile_required",
        },
      };
    }
    return {
      overlays,
      persistence: {
        available: true,
        profilePath: this.profilePath,
      },
    };
  }

  listEnabledAliasToolDefinitions(): WebMcpToolDefinition[] {
    return toAliasToolDefinitions(this.snapshot());
  }

  applyOverrideToolDefinitions(baseTools: ReadonlyArray<WebMcpToolDefinition>): WebMcpToolDefinition[] {
    const tools = new Map(baseTools.map((tool) => [tool.name, tool]));
    for (const overlay of this.snapshot()) {
      if (!overlay.enabled || overlay.activation !== "override") {
        continue;
      }
      for (const tool of overlay.tools) {
        tools.set(tool.name, toCanonicalToolDefinition(tool));
      }
    }
    return Array.from(tools.values());
  }

  getOverlayTool(name: string): { overlay: OverlayRecord; tool: OverlayToolRecord } | undefined {
    if (!name.startsWith("overlay.")) {
      return undefined;
    }
    const remainder = name.slice("overlay.".length);
    const separatorIndex = remainder.indexOf(".");
    if (separatorIndex <= 0) {
      return undefined;
    }
    const overlayId = remainder.slice(0, separatorIndex);
    const toolName = remainder.slice(separatorIndex + 1);
    const overlay = this.overlays.get(overlayId);
    if (!overlay || !overlay.enabled) {
      return undefined;
    }
    const tool = overlay.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      return undefined;
    }
    return { overlay, tool };
  }

  getOverrideTool(name: string): { overlay: OverlayRecord; tool: OverlayToolRecord } | undefined {
    for (const overlay of this.snapshot()) {
      if (!overlay.enabled || overlay.activation !== "override") {
        continue;
      }
      const tool = overlay.tools.find((entry) => entry.name === name);
      if (tool) {
        return { overlay, tool };
      }
    }
    return undefined;
  }

  private assertPersistentStore(): string {
    if (!this.profilePath) {
      throw new Error("CONFIG_ERROR: overlays require a managed profile session");
    }
    return this.profilePath;
  }

  async install(options: InstallOverlayOptions): Promise<OverlayRecord> {
    const id = options.id.trim();
    assertOverlayId(id);
    if (this.overlays.has(id)) {
      throw new Error(`OVERLAY_ALREADY_EXISTS: overlay ${id} already exists`);
    }
    if (!Array.isArray(options.tools) || options.tools.length === 0) {
      throw new Error("INVALID_ARGUMENT: overlay tools must be a non-empty array");
    }
    const overlay: OverlayRecord = {
      id,
      siteId: this.siteId,
      enabled: options.enabled ?? true,
      activation: options.activation ?? "namespaced",
      ...(options.description?.trim() ? { description: options.description.trim() } : {}),
      tools: options.tools.map((tool) => normalizeToolRecord(tool)),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    const profilePath = this.assertPersistentStore();
    const nextOverlays = new Map(this.overlays);
    nextOverlays.set(overlay.id, overlay);
    this.validateOverrideConflicts(this.snapshot(nextOverlays));
    await persistOverlay(profilePath, overlay);
    this.commit(nextOverlays);
    return cloneJsonValue(overlay);
  }

  async update(options: UpdateOverlayOptions): Promise<OverlayRecord> {
    const existing = this.overlays.get(options.id);
    if (!existing) {
      throw new Error(`OVERLAY_NOT_FOUND: overlay ${options.id} does not exist`);
    }
    const updated: OverlayRecord = {
      ...existing,
      ...(options.description !== undefined
        ? options.description.trim()
          ? { description: options.description.trim() }
          : {}
        : {}),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.activation !== undefined ? { activation: options.activation } : {}),
      ...(options.tools !== undefined ? { tools: options.tools.map((tool) => normalizeToolRecord(tool)) } : {}),
      updatedAt: timestamp(),
    };
    if (options.description !== undefined && !options.description.trim()) {
      delete updated.description;
    }
    const profilePath = this.assertPersistentStore();
    const nextOverlays = new Map(this.overlays);
    nextOverlays.set(updated.id, updated);
    this.validateOverrideConflicts(this.snapshot(nextOverlays));
    await persistOverlay(profilePath, updated);
    this.commit(nextOverlays);
    return cloneJsonValue(updated);
  }

  async enable(id: string): Promise<OverlayRecord> {
    return await this.update({ id, enabled: true });
  }

  async disable(id: string): Promise<OverlayRecord> {
    return await this.update({ id, enabled: false });
  }

  async delete(id: string): Promise<void> {
    if (!this.overlays.has(id)) {
      throw new Error(`OVERLAY_NOT_FOUND: overlay ${id} does not exist`);
    }
    const profilePath = this.assertPersistentStore();
    await rm(overlayFilePath(profilePath, id), { force: true });
    const nextOverlays = new Map(this.overlays);
    nextOverlays.delete(id);
    this.commit(nextOverlays);
  }

  async exportAdapterDraft(options: ExportOverlayOptions): Promise<ExportOverlayResult> {
    const profilePath = this.assertPersistentStore();
    const overlay = this.overlays.get(options.id);
    if (!overlay) {
      throw new Error(`OVERLAY_NOT_FOUND: overlay ${options.id} does not exist`);
    }
    const outputDir = overlayExportDirectory(profilePath, overlay.id);
    const srcDir = join(outputDir, "src");
    await mkdir(srcDir, { recursive: true });
    const packageName = toPackageName(this.siteId, overlay.id);
    const files = ["README.md", "package.json", "src/index.ts", "tsconfig.json"];
    const entryFile = join(outputDir, "src", "index.ts");
    await writeFile(entryFile, buildAdapterDraftSource(overlay, options.targetUrl, options.siteDisplayName, options.hostPatterns), "utf8");
    await writeFile(
      join(outputDir, "package.json"),
      `${JSON.stringify(
        {
          name: packageName,
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: {
            build: "tsc -p tsconfig.json",
            typecheck: "tsc --noEmit -p tsconfig.json",
          },
          dependencies: {
            "@webmcp-bridge/core": OVERLAY_EXPORT_PACKAGE_VERSION,
            "@webmcp-bridge/playwright": OVERLAY_EXPORT_PACKAGE_VERSION,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(outputDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            outDir: "dist",
            rootDir: "src",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            strict: true,
            declaration: true,
            sourceMap: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(outputDir, "README.md"), buildAdapterDraftReadme(overlay, outputDir), "utf8");
    return {
      overlay: cloneJsonValue(overlay),
      format: "adapter-draft",
      outputDir,
      entryFile,
      files: files.map((file) => join(outputDir, file)),
    };
  }
}

export async function readOverlayFile(profilePath: string, overlayId: string, siteId: string): Promise<OverlayRecord> {
  const raw = await readFile(overlayFilePath(profilePath, overlayId), "utf8");
  return normalizeOverlayRecord(JSON.parse(raw) as unknown, siteId);
}

export async function writeOverlayFile(profilePath: string, overlay: OverlayRecord): Promise<void> {
  await mkdir(dirname(overlayFilePath(profilePath, overlay.id)), { recursive: true });
  await persistOverlay(profilePath, normalizeOverlayRecord(overlay, overlay.siteId));
}
