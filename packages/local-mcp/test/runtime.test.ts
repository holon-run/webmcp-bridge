/**
 * This module tests local-mcp runtime URL resolution and host-pattern validation rules.
 * It depends on pure runtime helpers so adapter default URL and CLI override behavior remain deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  isRecoverableGatewayError,
  isUrlAllowed,
  mapNavigationError,
  resolveRecoveryNavigationUrl,
  resolveTargetUrl,
  selectPreferredPage,
  shouldEndOwnerSessionAfterPageClose,
  startLocalMcpRuntime,
} from "../src/runtime.js";

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

describe("isRecoverableGatewayError", () => {
  it("accepts execution-context teardown errors", () => {
    expect(isRecoverableGatewayError(new Error("Execution context was destroyed, most likely because of a navigation."))).toBe(true);
  });

  it("rejects unrelated gateway failures", () => {
    expect(isRecoverableGatewayError(new Error("AUTH_REQUIRED: login required"))).toBe(false);
  });
});

describe("resolveRecoveryNavigationUrl", () => {
  it("reuses the current page when the host remains allowed", () => {
    expect(
      resolveRecoveryNavigationUrl("https://board.mix.space/session/123", "https://board.mix.space", [
        "board.mix.space",
      ]),
    ).toBeUndefined();
  });

  it("navigates back to targetUrl when the current page is disallowed", () => {
    expect(
      resolveRecoveryNavigationUrl("https://example.com/other", "https://board.mix.space", [
        "board.mix.space",
      ]),
    ).toBe("https://board.mix.space");
  });
});

describe("shouldEndOwnerSessionAfterPageClose", () => {
  it("ends a headed owner session after the last page closes", () => {
    expect(shouldEndOwnerSessionAfterPageClose(false, 0)).toBe(true);
  });

  it("keeps a headed owner session alive while another page is open", () => {
    expect(shouldEndOwnerSessionAfterPageClose(false, 1)).toBe(false);
  });

  it("does not end a headless session from page-close semantics", () => {
    expect(shouldEndOwnerSessionAfterPageClose(true, 0)).toBe(false);
  });
});

describe("selectPreferredPage", () => {
  function createPage(url: string, closed = false) {
    return {
      url: () => url,
      isClosed: () => closed,
    };
  }

  it("prefers the exact target url when present", () => {
    const selected = selectPreferredPage(
      [
        createPage("https://www.google.com/search?q=openai"),
        createPage("https://gemini.google.com/"),
      ],
      "https://gemini.google.com/",
      ["gemini.google.com", "www.google.com"],
    );

    expect(selected?.url()).toBe("https://gemini.google.com/");
  });

  it("otherwise prefers pages on the target host over other allowed hosts", () => {
    const selected = selectPreferredPage(
      [
        createPage("https://www.google.com/search?q=openai"),
        createPage("https://gemini.google.com/app/abc"),
      ],
      "https://gemini.google.com/",
      ["gemini.google.com", "www.google.com"],
    );

    expect(selected?.url()).toBe("https://gemini.google.com/app/abc");
  });

  it("falls back to another allowed host when no target-host page exists", () => {
    const selected = selectPreferredPage(
      [
        createPage("chrome-extension://wallet/popup.html"),
        createPage("https://www.google.com/search?q=openai"),
      ],
      "https://gemini.google.com/",
      ["gemini.google.com", "www.google.com"],
    );

    expect(selected?.url()).toBe("https://www.google.com/search?q=openai");
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

  it("rejects browser attach urls for non-chromium engines", async () => {
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
        browserUrl: "http://127.0.0.1:9222",
      }),
    ).rejects.toThrow("CONFIG_ERROR: --browser-url requires --browser chromium");
  });

  it("rejects browser attach urls when a browser channel override is also set", async () => {
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
        browser: "chromium",
        browserUrl: "http://127.0.0.1:9222",
        browserChannel: "chrome",
      }),
    ).rejects.toThrow("CONFIG_ERROR: --browser-url cannot be combined with --browser-channel");
  });
});
