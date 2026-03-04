/**
 * This module defines supported site presets and fallback adapter factories.
 * It depends on adapter packages and is used by runtime startup to resolve site-specific defaults.
 */

import {
  createAdapter as createFixtureAdapter,
  manifest as fixtureManifest,
} from "@webmcp-bridge/adapter-fixture";
import {
  createAdapter as createXAdapter,
  manifest as xManifest,
} from "@webmcp-bridge/adapter-x";
import type { AdapterManifest, SiteAdapter } from "@webmcp-bridge/playwright";

export type SupportedSite = "x" | "fixture";

export type SiteDefinition = {
  id: SupportedSite;
  manifest: AdapterManifest;
  createFallbackAdapter: () => SiteAdapter;
};

const SITE_DEFINITIONS: Record<SupportedSite, SiteDefinition> = {
  x: {
    id: "x",
    manifest: xManifest,
    createFallbackAdapter: () => createXAdapter(),
  },
  fixture: {
    id: "fixture",
    manifest: fixtureManifest,
    createFallbackAdapter: () => createFixtureAdapter(),
  },
};

export function resolveSiteDefinition(site: string): SiteDefinition {
  if (site in SITE_DEFINITIONS) {
    return SITE_DEFINITIONS[site as SupportedSite];
  }
  throw new Error(`unsupported site: ${site}`);
}
