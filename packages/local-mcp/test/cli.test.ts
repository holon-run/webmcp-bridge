/**
 * This module tests local-mcp CLI argument parsing and built-in site resolution behavior.
 * It depends on CLI and site modules to validate deterministic startup option handling.
 */

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
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

  it("throws on missing required source", () => {
    expect(() => parseCliArgs([])).toThrow("missing required --site or --adapter-module");
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
