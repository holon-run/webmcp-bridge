/**
 * This module resolves stable managed-profile paths for local-mcp sessions.
 * It depends on site-definition metadata and target URLs so bridge startup can default to reusable profiles without CLI-only logic.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { SiteDefinition } from "./sites.js";

export const DEFAULT_PROFILE_ROOT = join(homedir(), ".uxc", "webmcp-profile");

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "site";
}

function resolveNativeProfileSlug(targetUrl: string): string {
  if (targetUrl === "about:blank") {
    return "about-blank";
  }
  const parsed = new URL(targetUrl);
  return slugify(parsed.hostname || parsed.protocol.replace(/:$/, ""));
}

export function resolveDefaultUserDataDir(siteDefinition: SiteDefinition, targetUrl: string): string {
  const slug = siteDefinition.source === "native" ? resolveNativeProfileSlug(targetUrl) : slugify(siteDefinition.id);
  return join(DEFAULT_PROFILE_ROOT, slug);
}
