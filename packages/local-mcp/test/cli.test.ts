/**
 * This module tests local-mcp CLI argument parsing and built-in site resolution behavior.
 * It depends on CLI and site modules to validate deterministic startup option handling.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule, parseCliArgs } from "../src/cli.js";
import { resolveSiteDefinition } from "../src/sites.js";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageVersion = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
  version: string;
};

describe("parseCliArgs", () => {
  afterEach(() => {
    delete process.env.WEBMCP_NAVIGATION_TIMEOUT_MS;
  });

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
      preferredPresentationMode: "headless",
      autoLoginFallback: true,
      serviceVersion: "0.2.0",
    });
  });

  it("parses a navigation timeout override", () => {
    const parsed = parseCliArgs(["--site", "x", "--navigation-timeout-ms", "20000"]);
    expect(parsed.navigationTimeoutMs).toBe(20000);
  });

  it("reads navigation timeout from the environment", () => {
    process.env.WEBMCP_NAVIGATION_TIMEOUT_MS = "25000";
    const parsed = parseCliArgs(["--site", "x"]);
    expect(parsed.navigationTimeoutMs).toBe(25000);
  });

  it("lets the CLI flag override the environment timeout", () => {
    process.env.WEBMCP_NAVIGATION_TIMEOUT_MS = "25000";
    const parsed = parseCliArgs(["--site", "x", "--navigation-timeout-ms", "18000"]);
    expect(parsed.navigationTimeoutMs).toBe(18000);
  });

  it("rejects invalid navigation timeout values", () => {
    expect(() => parseCliArgs(["--site", "x", "--navigation-timeout-ms", "0"])).toThrow(
      "invalid value for --navigation-timeout-ms: 0",
    );
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

  it("defaults serviceVersion to the package version", () => {
    const parsed = parseCliArgs(["--url", "https://board.holon.run"]);
    expect(parsed.serviceVersion).toBe(packageVersion.version);
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

  it("parses google site id", () => {
    const parsed = parseCliArgs(["--site", "google"]);
    expect(parsed.site).toBe("google");
  });

  it("parses weibo site id", () => {
    const parsed = parseCliArgs(["--site", "weibo"]);
    expect(parsed.site).toBe("weibo");
  });

  it("allows disabling auto login fallback", () => {
    const parsed = parseCliArgs(["--site", "x", "--headless", "--no-auto-login-fallback"]);
    expect(parsed.preferredPresentationMode).toBe("headless");
    expect(parsed.autoLoginFallback).toBe(false);
  });

  it("parses a chromium browser channel override", () => {
    const parsed = parseCliArgs(["--url", "https://board.holon.run", "--browser-channel", "chrome"]);
    expect(parsed.browser).toBe("chromium");
    expect(parsed.browserChannel).toBe("chrome");
  });

  it("parses an external browser attach url", () => {
    const parsed = parseCliArgs(["--url", "https://board.holon.run", "--browser-url", "http://127.0.0.1:9222"]);
    expect(parsed.browser).toBe("chromium");
    expect(parsed.browserUrl).toBe("http://127.0.0.1:9222");
  });

  it("parses the chromium login workaround flag", () => {
    const parsed = parseCliArgs(["--url", "https://board.holon.run", "--chromium-login-workaround"]);
    expect(parsed.browser).toBe("chromium");
    expect(parsed.chromiumLoginWorkaround).toBe(true);
  });

  it("rejects chromium login workaround for non-chromium browsers", () => {
    expect(() =>
      parseCliArgs(["--url", "https://board.holon.run", "--browser", "firefox", "--chromium-login-workaround"]),
    ).toThrow("--chromium-login-workaround requires --browser chromium (received firefox)");
  });

  it("throws on unsupported browser", () => {
    expect(() => parseCliArgs(["--site", "x", "--browser", "edge"])).toThrow(
      "unsupported browser: edge",
    );
  });

  it("throws on unsupported browser channel", () => {
    expect(() => parseCliArgs(["--url", "https://board.holon.run", "--browser-channel", "safari"])).toThrow(
      "unsupported browser channel: safari",
    );
  });
});

describe("resolveSiteDefinition", () => {
  it("resolves x site preset", () => {
    const site = resolveSiteDefinition("x");
    expect(site.manifest.defaultUrl).toContain("x.com");
    expect(site.manifest.hostPatterns).toContain("x.com");
    expect(site.manifest.authPolicy).toEqual({
      mode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
    });
  });

  it("resolves fixture site preset", () => {
    const site = resolveSiteDefinition("fixture");
    expect(site.manifest.defaultUrl).toBe("about:blank");
    expect(site.manifest.hostPatterns).toContain("about:blank");
  });

  it("resolves google site preset", () => {
    const site = resolveSiteDefinition("google");
    expect(site.manifest.defaultUrl).toContain("gemini.google.com");
    expect(site.manifest.hostPatterns).toContain("google.com");
  });

  it("resolves weibo site preset", () => {
    const site = resolveSiteDefinition("weibo");
    expect(site.manifest.defaultUrl).toBe("https://weibo.com");
    expect(site.manifest.hostPatterns).toContain("weibo.com");
    expect(site.manifest.authPolicy).toEqual({
      mode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
    });
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
