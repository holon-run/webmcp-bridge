/**
 * This module defines Playwright WebMCP gateway and fallback adapter contracts.
 * It is depended on by gateway lifecycle implementation and adapter packages.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { Page } from "playwright";

export type WebMcpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: {
    readOnlyHint?: boolean;
  };
};

export type WebMcpResourceDefinition = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type AdapterManifest = {
  id: string;
  displayName: string;
  version: string;
  bridgeApiVersion: string;
  defaultUrl?: string;
  hostPatterns: string[];
  authProbeTool?: string;
};

export type SiteAdapter = {
  name: string;
  listTools: (context: { page: Page }) => Promise<Array<WebMcpToolDefinition>>;
  callTool: (request: { name: string; input: JsonValue }, context: { page: Page }) => Promise<JsonValue>;
  start?: (context: { page: Page }) => Promise<void>;
  stop?: (context: { page: Page }) => Promise<void>;
};

export type SiteAdapterModule = {
  manifest: AdapterManifest;
  createAdapter: () => SiteAdapter;
};

export type CreateWebMcpPageGatewayOptions = {
  fallbackAdapter?: SiteAdapter;
  preferNative?: boolean;
  reinjectOnNavigate?: boolean;
  onError?: (error: unknown) => void;
};

export type WebMcpPageGateway = {
  id: string;
  mode: "native" | "polyfill" | "adapter-shim";
  page: Page;
  listTools: () => Promise<WebMcpToolDefinition[]>;
  callTool: (name: string, input: JsonValue) => Promise<JsonValue>;
  listResources: () => Promise<WebMcpResourceDefinition[]>;
  readResource: (uri: string) => Promise<JsonValue>;
  onResourceUpdated: (listener: (uri: string) => void) => () => void;
  close: () => Promise<void>;
};
