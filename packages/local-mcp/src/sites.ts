/**
 * This module defines built-in site presets and external adapter-module loading.
 * It depends on adapter packages and adapter contracts so runtime startup can resolve one fallback adapter source per process.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  createAdapter as createFixtureAdapter,
  manifest as fixtureManifest,
} from "@webmcp-bridge/adapter-fixture";
import {
  createAdapter as createXAdapter,
  manifest as xManifest,
} from "@webmcp-bridge/adapter-x";
import type {
  AdapterManifest,
  SiteAdapter,
  SiteAdapterModule,
} from "@webmcp-bridge/playwright";

export type BuiltinSite = "x" | "fixture";

export type SiteDefinition = {
  id: string;
  source: "builtin" | "external" | "native";
  manifest: AdapterManifest;
  createFallbackAdapter?: () => SiteAdapter;
  adapterModule?: string;
};

export type ResolveSiteSourceOptions = {
  site?: string;
  adapterModule?: string;
  moduleBaseDir?: string;
};

const BUILTIN_SITE_DEFINITIONS: Record<BuiltinSite, SiteDefinition> = {
  x: {
    id: "x",
    source: "builtin",
    manifest: xManifest,
    createFallbackAdapter: () => createXAdapter(),
  },
  fixture: {
    id: "fixture",
    source: "builtin",
    manifest: fixtureManifest,
    createFallbackAdapter: () => createFixtureAdapter(),
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateManifest(value: unknown): AdapterManifest {
  if (!isRecord(value)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: adapter manifest must be an object");
  }

  const id = value.id;
  const displayName = value.displayName;
  const version = value.version;
  const bridgeApiVersion = value.bridgeApiVersion;
  const defaultUrl = value.defaultUrl;
  const hostPatterns = value.hostPatterns;
  const authProbeTool = value.authProbeTool;

  if (!isNonEmptyString(id)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.id must be a non-empty string");
  }
  if (!isNonEmptyString(displayName)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.displayName must be a non-empty string");
  }
  if (!isNonEmptyString(version)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.version must be a non-empty string");
  }
  if (!isNonEmptyString(bridgeApiVersion)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.bridgeApiVersion must be a non-empty string");
  }
  if (defaultUrl !== undefined && !isNonEmptyString(defaultUrl)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.defaultUrl must be a non-empty string when provided");
  }
  if (!Array.isArray(hostPatterns) || hostPatterns.length === 0) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.hostPatterns must be a non-empty string array");
  }
  if (!hostPatterns.every((item) => isNonEmptyString(item))) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.hostPatterns must contain non-empty strings");
  }
  if (authProbeTool !== undefined && !isNonEmptyString(authProbeTool)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: manifest.authProbeTool must be a non-empty string when provided");
  }

  const output: AdapterManifest = {
    id,
    displayName,
    version,
    bridgeApiVersion,
    hostPatterns,
  };
  if (defaultUrl !== undefined) {
    output.defaultUrl = defaultUrl;
  }
  if (authProbeTool !== undefined) {
    output.authProbeTool = authProbeTool;
  }
  return output;
}

function validateSiteAdapterModule(value: unknown): SiteAdapterModule {
  if (!isRecord(value)) {
    throw new Error("ADAPTER_CONTRACT_ERROR: adapter module must export an object");
  }

  const root = isRecord(value.default) ? value.default : value;
  const createAdapter = root.createAdapter;
  if (typeof createAdapter !== "function") {
    throw new Error("ADAPTER_CONTRACT_ERROR: adapter module must export createAdapter()");
  }

  return {
    manifest: validateManifest(root.manifest),
    createAdapter: createAdapter as SiteAdapterModule["createAdapter"],
  };
}

function resolveAdapterModuleSpecifier(specifier: string, baseDir: string): string {
  const trimmed = specifier.trim();
  if (!trimmed) {
    throw new Error("ADAPTER_LOAD_ERROR: adapter module specifier is empty");
  }
  if (trimmed.startsWith("file:")) {
    return trimmed;
  }
  if (trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("..")) {
    const absolutePath = resolve(baseDir, trimmed);
    return pathToFileURL(absolutePath).href;
  }
  return trimmed;
}

async function resolveExternalSiteDefinition(
  adapterModule: string,
  moduleBaseDir: string,
): Promise<SiteDefinition> {
  const specifier = resolveAdapterModuleSpecifier(adapterModule, moduleBaseDir);

  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ADAPTER_LOAD_ERROR: failed to import adapter module (${adapterModule}): ${message}`);
  }

  const adapterModuleExports = validateSiteAdapterModule(loaded);
  return {
    id: adapterModuleExports.manifest.id,
    source: "external",
    manifest: adapterModuleExports.manifest,
    createFallbackAdapter: adapterModuleExports.createAdapter,
    adapterModule,
  };
}

export function resolveSiteDefinition(site: string): SiteDefinition {
  if (site in BUILTIN_SITE_DEFINITIONS) {
    return BUILTIN_SITE_DEFINITIONS[site as BuiltinSite];
  }
  throw new Error(`unsupported site: ${site}`);
}

export function createNativeSiteDefinition(url: string): SiteDefinition {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("CONFIG_ERROR: --url is required when --site/--adapter-module is not provided");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new Error("CONFIG_ERROR: --url must be a valid absolute URL");
  }

  let hostPatterns: string[];
  let id: string;
  if (parsed.protocol === "about:") {
    if (parsed.href !== "about:blank") {
      throw new Error("CONFIG_ERROR: url mode supports about:blank only for about: URLs");
    }
    hostPatterns = ["about:blank"];
    id = "native:about-blank";
  } else if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    hostPatterns = [parsed.hostname];
    id = `native:${parsed.hostname}`;
  } else {
    throw new Error("CONFIG_ERROR: --url must use http:, https:, or about:blank");
  }

  return {
    id,
    source: "native",
    manifest: {
      id,
      displayName: "Native WebMCP Site",
      version: "0.1.0",
      bridgeApiVersion: "1.0.0",
      defaultUrl: parsed.href,
      hostPatterns,
    },
  };
}

export async function resolveSiteSource(options: ResolveSiteSourceOptions): Promise<SiteDefinition> {
  const site = options.site?.trim();
  const adapterModule = options.adapterModule?.trim();

  if (site && adapterModule) {
    throw new Error("CONFIG_ERROR: use either --site or --adapter-module, not both");
  }
  if (!site && !adapterModule) {
    throw new Error("CONFIG_ERROR: one of --site or --adapter-module is required");
  }

  if (site) {
    return resolveSiteDefinition(site);
  }

  const moduleBaseDir = options.moduleBaseDir ?? process.cwd();
  return await resolveExternalSiteDefinition(adapterModule as string, moduleBaseDir);
}
