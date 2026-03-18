/**
 * This module tests the package-level low-level utilities exported by adapter-utils.
 * It keeps coverage focused on pure helpers that are expected to stay reusable across adapters.
 */

import { describe, expect, it } from "vitest";
import {
  applyHeaderAllowlist,
  buildRequestCaptureInitScript,
  collectTextByTag,
  captureRoutedResponseText,
  dedupeStrings,
  fromDomFallback,
  fromNetwork,
  joinTextParts,
  normalizeText,
  parseNdjsonLines,
  selectLatestRequestTemplate,
  TemplateCache,
  toRequestTemplate,
} from "../src/index.js";

describe("adapter-utils", () => {
  it("normalizes and deduplicates text", () => {
    expect(normalizeText("  hello \n world  ")).toBe("hello world");
    expect(dedupeStrings(["a", "a", "b", "b", "a"])).toEqual(["a", "b", "a"]);
    expect(joinTextParts(["  hello", " ", "world  "])).toBe("helloworld");
  });

  it("parses ndjson and collects tagged text", () => {
    const entries = parseNdjsonLines<{ message?: string; messageTag?: string }>(
      `{"message":"foo","messageTag":"final"}\n{"message":"bar","messageTag":"summary"}\n{"message":"baz","messageTag":"final"}\nnot-json\n`,
    );

    expect(entries).toEqual([
      { message: "foo", messageTag: "final" },
      { message: "bar", messageTag: "summary" },
      { message: "baz", messageTag: "final" },
    ]);
    expect(collectTextByTag(entries, "final")).toEqual(["foo", "baz"]);
  });

  it("filters headers and caches templates", () => {
    expect(
      applyHeaderAllowlist(
        {
          Authorization: "Bearer token",
          Cookie: "secret",
          "x-csrf-token": "csrf",
        },
        ["authorization", "x-csrf-token"],
      ),
    ).toEqual({
      Authorization: "Bearer token",
      "x-csrf-token": "csrf",
    });

    const cache = new TemplateCache<string, { url: string }>();
    cache.set("timeline", { url: "/graphql/home" });
    expect(cache.has("timeline")).toBe(true);
    expect(cache.get("timeline")).toEqual({ url: "/graphql/home" });
    expect(cache.delete("timeline")).toBe(true);
    expect(cache.get("timeline")).toBeUndefined();
  });

  it("converts captured entries and selects the latest matching template", () => {
    expect(
      toRequestTemplate({
        url: "/graphql/home",
        method: "POST",
        headers: { authorization: "Bearer token" },
        body: "{\"count\":20}",
      }),
    ).toEqual({
      url: "/graphql/home",
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: "{\"count\":20}",
    });

    expect(
      selectLatestRequestTemplate(
        [
          { url: "/graphql/home", method: "GET" },
          { url: "/graphql/search", method: "POST" },
          { url: "/graphql/home?cursor=1", method: "POST", headers: { authorization: "Bearer token" } },
        ],
        (entry) => typeof entry.url === "string" && entry.url.includes("/graphql/home"),
      ),
    ).toEqual({
      url: "/graphql/home?cursor=1",
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
  });

  it("builds a request capture init script with generic hooks", () => {
    const script = buildRequestCaptureInitScript({
      globalKey: "__TEST_CAPTURE__",
      shouldCaptureSource: "((url, method) => method === 'POST' && url.includes('/graphql/'))",
      enrichEntrySource: "((entry) => ({ ...entry, op: 'TestOp' }))",
      maxEntries: 10,
    });

    expect(script).toContain("__TEST_CAPTURE__");
    expect(script).toContain("method === 'POST'");
    expect(script).toContain("op: 'TestOp'");
    expect(script).toContain("state.entries.length > maxEntries");
  });

  it("creates explicit network and dom fallback results", () => {
    expect(fromNetwork([{ id: "1" }])).toEqual({
      source: "network",
      data: [{ id: "1" }],
      reason: undefined,
    });
    expect(fromDomFallback([{ id: "1" }], "no_template")).toEqual({
      source: "dom",
      data: [{ id: "1" }],
      reason: "no_template",
    });
  });

  it("captures routed response text with a minimal page-like object", async () => {
    let registeredHandler: ((route: { request(): { method(): string }; continue(): Promise<void>; fetch(): Promise<{ status(): number; text(): Promise<string> }>; fulfill(): Promise<void>; }) => Promise<void>) | undefined;
    let continueCalls = 0;
    const page = {
      route: async (_pattern: string, handler: typeof registeredHandler) => {
        registeredHandler = handler;
      },
      unroute: async () => {},
      waitForTimeout: async () => {},
    };

    const result = await captureRoutedResponseText(
      page as never,
      "**/demo",
      async () => {
        if (!registeredHandler) {
          return false;
        }
        await registeredHandler({
          request: () => ({ method: () => "POST" }),
          continue: async () => {
            continueCalls += 1;
          },
          fetch: async () => ({
            status: () => 200,
            text: async () => "{\"ok\":true}",
          }),
          fulfill: async () => {},
        });
        await registeredHandler({
          request: () => ({ method: () => "POST" }),
          continue: async () => {
            continueCalls += 1;
          },
          fetch: async () => ({
            status: () => 200,
            text: async () => "{\"ok\":false}",
          }),
          fulfill: async () => {},
        });
        return true;
      },
    );

    expect(result).toEqual({
      method: "POST",
      status: 200,
      text: "{\"ok\":true}",
    });
    expect(continueCalls).toBe(1);
  });
});
