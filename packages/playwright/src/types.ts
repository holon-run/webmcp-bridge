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

export type SiteAdapter = {
  name: string;
  listTools: (context: { page: Page }) => Promise<Array<{ name: string; description?: string }>>;
  callTool: (request: { name: string; input: JsonValue }, context: { page: Page }) => Promise<JsonValue>;
  start?: (context: { page: Page }) => Promise<void>;
  stop?: (context: { page: Page }) => Promise<void>;
};

export type CreateWebMcpPageGatewayOptions = {
  fallbackAdapter?: SiteAdapter;
  preferNative?: boolean;
  reinjectOnNavigate?: boolean;
};

export type WebMcpPageGateway = {
  id: string;
  mode: "native" | "shim";
  page: Page;
  listTools: () => Promise<WebMcpToolDefinition[]>;
  callTool: (name: string, input: JsonValue) => Promise<JsonValue>;
  close: () => Promise<void>;
};
