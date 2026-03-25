/**
 * This module exposes the adapter-weibo package public API.
 * It depends on the adapter factory module for external consumption and local-mcp preset wiring.
 */

import type { AdapterManifest } from "@webmcp-bridge/playwright";
import { createWeiboAdapter } from "./adapter.js";

export const manifest: AdapterManifest = {
  id: "weibo.com",
  displayName: "Weibo",
  version: "0.5.1",
  bridgeApiVersion: "1.0.0",
  defaultUrl: "https://weibo.com",
  hostPatterns: ["weibo.com", "www.weibo.com", "*.weibo.com", "m.weibo.cn"],
  authPolicy: {
    mode: "bootstrap_then_attach",
    authProbeTool: "auth.get",
    allowAnonymousTools: true,
  },
};

export function createAdapter() {
  return createWeiboAdapter();
}

export * from "./adapter.js";
