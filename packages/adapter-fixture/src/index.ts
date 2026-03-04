/**
 * This module exposes the adapter-fixture package public API.
 * It depends on the fixture adapter factory for external consumption in tests.
 */

import type { AdapterManifest } from "@webmcp-bridge/playwright";
import { createFixtureAdapter } from "./adapter.js";

export const manifest: AdapterManifest = {
  id: "fixture",
  displayName: "Fixture",
  version: "0.1.0",
  bridgeApiVersion: "1.0.0",
  defaultUrl: "about:blank",
  hostPatterns: ["about:blank"],
};

export function createAdapter() {
  return createFixtureAdapter();
}

export * from "./adapter.js";
