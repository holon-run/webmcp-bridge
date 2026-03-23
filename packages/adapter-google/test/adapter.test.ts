/**
 * This module tests adapter-google schema validation and lightweight page-driven behavior.
 * It depends on the adapter factory and page-like mocks so Google-specific contract checks stay deterministic.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createAdapter } from "../src/index.js";

function createMockPage(options?: {
  url?: string;
  title?: string;
  evalResponse?: unknown;
  evalResponses?: unknown[];
  waitForEventError?: Error;
}) {
  const evalResponses = options?.evalResponses ? [...options.evalResponses] : undefined;
  const textboxFill = vi.fn(async () => {});
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => options?.url ?? "https://gemini.google.com/app"),
    title: vi.fn(async () => options?.title ?? "Google Gemini"),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => (evalResponses ? evalResponses.shift() : options?.evalResponse)),
    locator: vi.fn(() => ({
      first: () => ({
        click: vi.fn(async () => {}),
        fill: textboxFill,
      }),
      count: vi.fn(async () => 0),
      nth: vi.fn(() => ({
        click: vi.fn(async () => {}),
      })),
    })),
    getByRole: vi.fn(() => ({
      first: () => ({
        click: vi.fn(async () => {}),
      }),
    })),
    waitForEvent: vi.fn(async () => {
      if (options?.waitForEventError) {
        throw options.waitForEventError;
      }
      return {
        suggestedFilename: () => "image.png",
        saveAs: async () => {},
      };
    }),
    textboxFill,
  };
}

describe("createAdapter", () => {
  it("reports auth_required on Google Accounts pages", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      url: "https://accounts.google.com/v3/signin/challenge",
      title: "Sign in - Google Accounts",
      evalResponse: {
        hasSignInText: true,
        hasGeminiMarker: false,
        hasGoogleAccountMarker: false,
      },
    });

    await expect(adapter.callTool({ name: "auth.get", input: {} }, { page: page as never })).resolves.toEqual({
      state: "auth_required",
      url: "https://accounts.google.com/v3/signin/challenge",
      title: "Sign in - Google Accounts",
      signals: ["accounts-host", "signin-text"],
      source: "adapter-google",
    });
  });

  it("validates required query for search.web", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(adapter.callTool({ name: "search.web", input: {} }, { page: page as never })).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "query is required",
      },
    });
  });

  it("rejects non-google URLs for page.navigate", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(
      adapter.callTool(
        { name: "page.navigate", input: { url: "https://example.com/not-allowed" } },
        { page: page as never },
      ),
    ).resolves.toEqual({
      error: {
        code: "URL_NOT_ALLOWED",
        message: "url must stay within google.com hosts",
      },
    });
  });

  it("returns search results from the evaluated Google page snapshot", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      url: "https://www.google.com/search?q=openai+api&hl=en",
      title: "openai api - Google Search",
      evalResponse: {
        url: "https://www.google.com/search?q=openai+api&hl=en",
        title: "openai api - Google Search",
        query: "openai api",
        items: [
          {
            title: "API Platform",
            url: "https://openai.com/api/",
            snippet: "OpenAI API platform overview",
            displayText: "API Platform OpenAI https://openai.com/api/",
          },
        ],
      },
    });

    await expect(
      adapter.callTool(
        { name: "search.web", input: { query: "openai api", limit: 5 } },
        { page: page as never },
      ),
    ).resolves.toEqual({
      url: "https://www.google.com/search?q=openai+api&hl=en",
      title: "openai api - Google Search",
      query: "openai api",
      items: [
        {
          title: "API Platform",
          url: "https://openai.com/api/",
          snippet: "OpenAI API platform overview",
          displayText: "API Platform OpenAI https://openai.com/api/",
        },
      ],
      source: "dom",
    });
  });

  it("falls back to direct image src download when the browser download event is unavailable", async () => {
    const adapter = createAdapter();
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const page = createMockPage({
      url: "https://gemini.google.com/app/example",
      title: "Google Gemini",
      evalResponses: [
        {
          hasSignInText: false,
          hasGeminiMarker: true,
          hasGoogleAccountMarker: false,
        },
        {
          status: "ready",
        },
        [
          {
            index: 0,
            src: "https://lh3.googleusercontent.com/generated-image",
          },
        ],
      ],
      waitForEventError: new Error("download event unavailable"),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
      }),
      arrayBuffer: async () => imageBytes.buffer,
    })) as typeof fetch;

    try {
      const result = await adapter.callTool(
        {
          name: "gemini.image.download",
          input: {
            limit: 1,
            timeoutMs: 5_000,
          },
        },
        { page: page as never },
      );

      expect(result).toMatchObject({
        conversationUrl: "https://gemini.google.com/app/example",
        items: [
          {
            index: 0,
            artifact: {
              kind: "file",
              name: "gemini-image-1.png",
              imageIndex: 0,
              mimeType: "image/png",
            },
          },
        ],
        source: "dom",
      });

      const typedResult = result as {
        items: Array<{ artifact: { path: string } }>;
      };
      const savedBytes = await readFile(typedResult.items[0].artifact.path);
      expect(Array.from(savedBytes)).toEqual(Array.from(imageBytes));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("submits long gemini prompts in one shot and waits for a new response", async () => {
    const adapter = createAdapter();
    const prompt = "long prompt ".repeat(200);
    const page = createMockPage({
      url: "https://gemini.google.com/app/chat",
      title: "Google Gemini",
      evalResponses: [
        {
          hasSignInText: false,
          hasGeminiMarker: true,
          hasGoogleAccountMarker: false,
        },
        {
          conversationUrl: "https://gemini.google.com/app/chat",
          responseText: "previous answer",
          images: [],
        },
        true,
        {
          status: "pending",
          active: true,
          responseText: "previous answer",
          fingerprint: "thinking-1",
        },
        {
          status: "ready",
          responseText: "fresh answer",
        },
        {
          conversationUrl: "https://gemini.google.com/app/chat",
          responseText: "fresh answer",
          images: [],
        },
      ],
    });

    const result = await adapter.callTool(
      { name: "gemini.chat", input: { prompt, timeoutMs: 1_000 } },
      { page: page as never },
    );

    expect(page.textboxFill).not.toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenNthCalledWith(
      3,
      expect.any(Function),
      expect.objectContaining({ value: prompt }),
    );
    expect(result).toEqual({
      prompt,
      mode: "text",
      conversationUrl: "https://gemini.google.com/app/chat",
      responseText: "fresh answer",
      images: [],
      source: "dom",
    });
  });

  it("fails closed when Gemini surfaces an upstream error while waiting", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      url: "https://gemini.google.com/app/chat",
      title: "Google Gemini",
      evalResponses: [
        {
          hasSignInText: false,
          hasGeminiMarker: true,
          hasGoogleAccountMarker: false,
        },
        {
          conversationUrl: "https://gemini.google.com/app/chat",
          responseText: null,
          images: [],
        },
        true,
        {
          status: "error",
          message: "Something went wrong",
        },
      ],
    });

    const result = await adapter.callTool(
      { name: "gemini.chat", input: { prompt: "hello", timeoutMs: 1_000 } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "UPSTREAM_CHANGED",
        message: "Gemini failed to complete the request",
        details: {
          mode: "text",
          message: "Something went wrong",
          url: "https://gemini.google.com/app/chat",
        },
      },
    });
  });
});
