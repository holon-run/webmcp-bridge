/**
 * This module exposes the adapter-x package public API.
 * It depends on the adapter factory module for external consumption.
 */

import type { AdapterManifest } from "@webmcp-bridge/playwright";
import { createXAdapter } from "./adapter.js";

export const manifest: AdapterManifest = {
  id: "x.com",
  displayName: "X",
  version: "0.1.0",
  bridgeApiVersion: "1.0.0",
  defaultUrl: "https://x.com/home",
  hostPatterns: ["x.com", "www.x.com", "*.x.com"],
  authProbeTool: "auth.get",
};

export function createAdapter() {
  return createXAdapter();
}

export * from "./adapter.js";
