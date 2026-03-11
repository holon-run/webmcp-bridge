/**
 * This module tests local-mcp CLI argument parsing and built-in site resolution behavior.
 * It depends on CLI and site modules to validate deterministic startup option handling.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule, parseCliArgs } from "../src/cli.js";
import { resolveSiteDefinition } from "../src/sites.js";

describe("parseCliArgs", () => {
  it("parses built-in site with optional flags", () => {
    const parsed = parseCliArgs([
      "--site",
      "x",
      "--url",
      "https://example.com",
      "--browser",
      "firefox",
      "--headless",
      "--service-version",
      "0.2.0",
    ]);

    expect(parsed).toEqual({
      site: "x",
      url: "https://example.com",
      browser: "firefox",
      headless: true,
      autoLoginFallback: true,
      serviceVersion: "0.2.0",
    });
  });

  it("parses external adapter module", () => {
    const parsed = parseCliArgs(["--adapter-module", "@example/webmcp-adapter"]);
    expect(parsed.adapterModule).toBe("@example/webmcp-adapter");
    expect(parsed.site).toBeUndefined();
  });

  it("parses native-only mode when url is provided without adapter source", () => {
    const parsed = parseCliArgs(["--url", "https://www.meetcursive.com"]);
    expect(parsed.site).toBeUndefined();
    expect(parsed.adapterModule).toBeUndefined();
    expect(parsed.url).toBe("https://www.meetcursive.com");
  });

  it("throws on missing required source and url", () => {
    expect(() => parseCliArgs([])).toThrow("missing required --url or one of --site/--adapter-module");
  });

  it("throws when site and adapter-module are both set", () => {
    expect(() => parseCliArgs(["--site", "x", "--adapter-module", "./adapter.mjs"])).toThrow(
      "use either --site or --adapter-module, not both",
    );
  });

  it("parses fixture site id", () => {
    const parsed = parseCliArgs(["--site", "fixture"]);
    expect(parsed.site).toBe("fixture");
    expect(parsed.autoLoginFallback).toBe(true);
  });

  it("allows disabling auto login fallback", () => {
    const parsed = parseCliArgs(["--site", "x", "--headless", "--no-auto-login-fallback"]);
    expect(parsed.headless).toBe(true);
    expect(parsed.autoLoginFallback).toBe(false);
  });

  it("throws on unsupported browser", () => {
    expect(() => parseCliArgs(["--site", "x", "--browser", "edge"])).toThrow(
      "unsupported browser: edge",
    );
  });
});

describe("resolveSiteDefinition", () => {
  it("resolves x site preset", () => {
    const site = resolveSiteDefinition("x");
    expect(site.manifest.defaultUrl).toContain("x.com");
    expect(site.manifest.hostPatterns).toContain("x.com");
  });

  it("resolves fixture site preset", () => {
    const site = resolveSiteDefinition("fixture");
    expect(site.manifest.defaultUrl).toBe("about:blank");
    expect(site.manifest.hostPatterns).toContain("about:blank");
  });

  it("throws on unsupported site", () => {
    expect(() => resolveSiteDefinition("unknown")).toThrow("unsupported site: unknown");
  });
});

describe("isMainModule", () => {
  it("returns true when main path is the same file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "webmcp-cli-main-"));
    try {
      const entryPath = join(tempDir, "entry.mjs");
      writeFileSync(entryPath, "export {};\n", "utf8");
      expect(isMainModule(pathToFileURL(entryPath).href, entryPath)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns true when main path is a symlink to the same file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "webmcp-cli-link-"));
    try {
      const entryPath = join(tempDir, "entry.mjs");
      const symlinkPath = join(tempDir, "link.mjs");
      writeFileSync(entryPath, "export {};\n", "utf8");
      symlinkSync(entryPath, symlinkPath);
      expect(isMainModule(pathToFileURL(entryPath).href, symlinkPath)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns false when main path points to a different file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "webmcp-cli-mismatch-"));
    try {
      const entryPath = join(tempDir, "entry.mjs");
      const otherPath = join(tempDir, "other.mjs");
      writeFileSync(entryPath, "export {};\n", "utf8");
      writeFileSync(otherPath, "export {};\n", "utf8");
      expect(isMainModule(pathToFileURL(entryPath).href, otherPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
