/**
 * This module defines supported site presets and fallback adapter factories.
 * It depends on adapter packages and is used by runtime startup to resolve site-specific defaults.
 */

import { createFixtureAdapter } from "@webmcp-bridge/adapter-fixture";
import { createXAdapter } from "@webmcp-bridge/adapter-x";
import type { SiteAdapter } from "@webmcp-bridge/playwright";

export type SupportedSite = "x" | "fixture";

export type SiteDefinition = {
  id: SupportedSite;
  defaultUrl: string;
  createFallbackAdapter: () => SiteAdapter;
};

const SITE_DEFINITIONS: Record<SupportedSite, SiteDefinition> = {
  x: {
    id: "x",
    defaultUrl: "https://x.com/home",
    createFallbackAdapter: () => createXAdapter(),
  },
  fixture: {
    id: "fixture",
    defaultUrl: "about:blank",
    createFallbackAdapter: () => createFixtureAdapter(),
  },
};

export function resolveSiteDefinition(site: string): SiteDefinition {
  if (site in SITE_DEFINITIONS) {
    return SITE_DEFINITIONS[site as SupportedSite];
  }
  throw new Error(`unsupported site: ${site}`);
}
