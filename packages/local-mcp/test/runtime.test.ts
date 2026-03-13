/**
 * This module tests local-mcp runtime URL resolution and host-pattern validation rules.
 * It depends on pure runtime helpers so adapter default URL and CLI override behavior remain deterministic.
 */

import { describe, expect, it } from "vitest";
import { isUrlAllowed, mapNavigationError, resolveTargetUrl, startLocalMcpRuntime } from "../src/runtime.js";

describe("resolveTargetUrl", () => {
  it("prefers explicit override", () => {
    expect(resolveTargetUrl("https://x.com/i/bookmarks", "https://x.com/home")).toBe(
      "https://x.com/i/bookmarks",
    );
  });

  it("falls back to manifest default", () => {
    expect(resolveTargetUrl(undefined, "https://x.com/home")).toBe("https://x.com/home");
  });

  it("throws when both override and default are missing", () => {
    expect(() => resolveTargetUrl(undefined, undefined)).toThrow(
      "CONFIG_ERROR: no target url provided (missing --url and manifest.defaultUrl)",
    );
  });
});

describe("isUrlAllowed", () => {
  it("accepts exact host match", () => {
    expect(isUrlAllowed("https://x.com/home", ["x.com"])).toBe(true);
  });

  it("accepts wildcard subdomain match", () => {
    expect(isUrlAllowed("https://api.x.com/home", ["*.x.com"])).toBe(true);
  });

  it("does not let wildcard match root domain", () => {
    expect(isUrlAllowed("https://x.com/home", ["*.x.com"])).toBe(false);
  });

  it("rejects unknown hosts", () => {
    expect(isUrlAllowed("https://example.com", ["x.com", "*.x.com"])).toBe(false);
  });

  it("allows about:blank only when declared", () => {
    expect(isUrlAllowed("about:blank", ["about:blank"])).toBe(true);
    expect(isUrlAllowed("about:blank", ["x.com"])).toBe(false);
  });
});

describe("mapNavigationError", () => {
  it("maps connection errors to TARGET_UNREACHABLE", () => {
    const error = mapNavigationError(
      new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/"),
      "http://127.0.0.1:4173",
      "goto",
    );

    expect(error.message).toContain("TARGET_UNREACHABLE");
    expect(error.message).toContain("http://127.0.0.1:4173");
  });

  it("maps timeout errors to NAVIGATION_TIMEOUT", () => {
    const error = mapNavigationError(
      new Error("page.goto: Timeout 5000ms exceeded."),
      "http://127.0.0.1:4173",
      "goto",
    );

    expect(error.message).toContain("NAVIGATION_TIMEOUT");
  });
});

describe("startLocalMcpRuntime", () => {
  it("rejects browser channels for non-chromium engines", async () => {
    await expect(
      startLocalMcpRuntime({
        siteDefinition: {
          id: "test",
          source: "native",
          manifest: {
            id: "test",
            displayName: "Test",
            version: "0.1.0",
            bridgeApiVersion: "0.1.0",
            defaultUrl: "https://example.com",
            hostPatterns: ["example.com"],
          },
        },
        url: "https://example.com",
        browser: "firefox",
        browserChannel: "chrome",
      }),
    ).rejects.toThrow("CONFIG_ERROR: --browser-channel requires --browser chromium");
  });
});
