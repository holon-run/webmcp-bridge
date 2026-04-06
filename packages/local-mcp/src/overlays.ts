/**
 * This module persists profile-scoped overlay tool definitions and runs overlay/debug scripts in the page context.
 * It depends on Node filesystem APIs and Playwright page evaluation so local-mcp can evolve draft site tools without modifying shared gateway layers.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@webmcp-bridge/core";
import type { WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import type { Page } from "playwright";

const OVERLAY_DIR = ".webmcp-bridge/overlays";
const OVERLAY_FILE_SUFFIX = ".json";
const OVERLAY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

type OverlayAnnotationRecord = {
  readOnlyHint?: boolean;
};

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
  description?: string;
  tools: OverlayToolRecord[];
  createdAt: string;
  updatedAt: string;
};

export type InstallOverlayOptions = {
  id: string;
  description?: string;
  enabled?: boolean;
  tools: OverlayToolRecord[];
};

export type UpdateOverlayOptions = {
  id: string;
  description?: string;
  enabled?: boolean;
  tools?: OverlayToolRecord[];
};

export type OverlayListResult = {
  overlays: OverlayRecord[];
  persistence: {
    available: boolean;
    reason?: "managed_profile_required";
    profilePath?: string;
  };
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

export function toOverlayToolDefinitions(overlays: ReadonlyArray<OverlayRecord>): WebMcpToolDefinition[] {
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

export class OverlayStore {
  private overlays = new Map<string, OverlayRecord>();

  constructor(
    private readonly siteId: string,
    private readonly profilePath?: string,
  ) {}

  async load(): Promise<void> {
    this.overlays.clear();
    if (!this.profilePath) {
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
      this.overlays.set(overlay.id, overlay);
    }
  }

  list(): OverlayListResult {
    const overlays = Array.from(this.overlays.values()).sort((a, b) => a.id.localeCompare(b.id));
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

  listEnabledToolDefinitions(): WebMcpToolDefinition[] {
    return toOverlayToolDefinitions(Array.from(this.overlays.values()));
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
      ...(options.description?.trim() ? { description: options.description.trim() } : {}),
      tools: options.tools.map((tool) => normalizeToolRecord(tool)),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    const profilePath = this.assertPersistentStore();
    await persistOverlay(profilePath, overlay);
    this.overlays.set(overlay.id, overlay);
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
      ...(options.tools !== undefined ? { tools: options.tools.map((tool) => normalizeToolRecord(tool)) } : {}),
      updatedAt: timestamp(),
    };
    if (options.description !== undefined && !options.description.trim()) {
      delete updated.description;
    }
    const profilePath = this.assertPersistentStore();
    await persistOverlay(profilePath, updated);
    this.overlays.set(updated.id, updated);
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
    this.overlays.delete(id);
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
