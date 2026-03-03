/**
 * This module defines Playwright integration contracts for WebMCP bridge sessions.
 * It is depended on by attach/detach lifecycle implementation and adapter packages.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { Page } from "playwright";

export type SiteAdapter = {
  name: string;
  listTools: (context: { page: Page }) => Promise<Array<{ name: string; description?: string }>>;
  callTool: (request: { name: string; input: JsonValue }, context: { page: Page }) => Promise<JsonValue>;
  start?: (context: { page: Page }) => Promise<void>;
  stop?: (context: { page: Page }) => Promise<void>;
};

export type PlaywrightBridgeOptions = {
  adapter: SiteAdapter;
  preferNative?: boolean;
  reinjectOnNavigate?: boolean;
};

export type PlaywrightBridgeSession = {
  id: string;
  mode: "native" | "shim";
  page: Page;
  adapter: SiteAdapter;
};
