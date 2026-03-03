/**
 * This module tests local-mcp CLI argument parsing and site resolution behavior.
 * It depends on CLI and site modules to validate deterministic startup option handling.
 */

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
import { resolveSiteDefinition } from "../src/sites.js";

describe("parseCliArgs", () => {
  it("parses required and optional flags", () => {
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
      serviceVersion: "0.2.0",
    });
  });

  it("throws on missing required --site", () => {
    expect(() => parseCliArgs([])).toThrow("missing required --site");
  });

  it("parses fixture site id", () => {
    const parsed = parseCliArgs(["--site", "fixture"]);
    expect(parsed.site).toBe("fixture");
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
    expect(site.defaultUrl).toContain("x.com");
  });

  it("resolves fixture site preset", () => {
    const site = resolveSiteDefinition("fixture");
    expect(site.defaultUrl).toBe("about:blank");
  });

  it("throws on unsupported site", () => {
    expect(() => resolveSiteDefinition("unknown")).toThrow("unsupported site: unknown");
  });
});
