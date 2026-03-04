/**
 * This module tests adapter-x auth gating, compose confirmation, and schema-level behavior.
 * It depends on adapter factory APIs and page-like mocks to keep unit assertions deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { createXAdapter } from "../src/index.js";

type Behavior = {
  authState: "authenticated" | "auth_required" | "challenge_required";
  authSignals: string[];
  timelineItems: Array<{ id: string; text: string; url?: string }>;
  networkNextCursor?: string;
  requireFallbackTemplate?: boolean;
  composeResult: { ok: boolean; dryRun?: boolean; reason?: string; submitVisible?: boolean };
  confirmCompose: boolean;
  statusUrl?: string;
};

function createMockPage(partial: Partial<Behavior> = {}) {
  const behavior: Behavior = {
    authState: "authenticated",
    authSignals: ["authenticated_ui"],
    timelineItems: [{ id: "timeline-1", text: "hello", url: "https://x.com/a/status/1" }],
    networkNextCursor: "cursor-next",
    requireFallbackTemplate: false,
    composeResult: { ok: true },
    confirmCompose: true,
    statusUrl: "https://x.com/example/status/123",
    ...partial,
  };

  const readPage = {
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
        return undefined;
      }

      const command = arg as Record<string, unknown>;
      if (command.op === "detect_auth") {
        return {
          state: behavior.authState,
          signals: behavior.authSignals,
        };
      }

      if (typeof command.mode === "string" && typeof command.limit === "number") {
        if (behavior.requireFallbackTemplate && command.cachedTemplate === undefined) {
          return {
            items: [],
            source: "dom",
            reason: "no_template",
          };
        }
        return {
          items: behavior.timelineItems.slice(0, command.limit),
          source: "network",
          nextCursor: behavior.networkNextCursor,
          selectedTemplate: {
            url: "https://x.com/i/api/graphql/mock/Bookmarks",
            method: "GET",
            headers: {
              authorization: "Bearer mock",
              "x-csrf-token": "mock",
            },
          },
        };
      }

      if (typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (typeof command.content === "string" && typeof command.dryRunMode === "boolean") {
        return behavior.composeResult;
      }

      if (typeof command.needle === "string") {
        return behavior.statusUrl;
      }

      return undefined;
    }),
    addInitScript: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => true),
    reload: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    url: vi.fn(() => "https://x.com/i/bookmarks"),
    isClosed: vi.fn(() => false),
  };
  const newPage = vi.fn(async () => readPage);

  const page = {
    addInitScript: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
        return undefined;
      }

      const command = arg as Record<string, unknown>;
      if (command.op === "detect_auth") {
        return {
          state: behavior.authState,
          signals: behavior.authSignals,
        };
      }

      if (typeof command.mode === "string" && typeof command.limit === "number") {
        if (behavior.requireFallbackTemplate && command.cachedTemplate === undefined) {
          return {
            items: [],
            source: "dom",
            reason: "no_template",
          };
        }
        return {
          items: behavior.timelineItems.slice(0, command.limit),
          source: "network",
          nextCursor: behavior.networkNextCursor,
          selectedTemplate: {
            url: "https://x.com/i/api/graphql/mock/HomeTimeline",
            method: "GET",
            headers: {
              authorization: "Bearer mock",
              "x-csrf-token": "mock",
            },
          },
        };
      }

      if (typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (typeof command.content === "string" && typeof command.dryRunMode === "boolean") {
        return behavior.composeResult;
      }

      if (typeof command.needle === "string") {
        return behavior.statusUrl;
      }

      return undefined;
    }),
    waitForSelector: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {
      if (!behavior.confirmCompose) {
        throw new Error("timeout");
      }
      return true;
    }),
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    url: vi.fn(() => "https://x.com/home"),
    isClosed: vi.fn(() => false),
    context: vi.fn(() => ({
      newPage,
    })),
  };

  return {
    page,
    readPage,
    newPage,
    behavior,
  };
}

describe("createXAdapter", () => {
  it("publishes tool schemas", async () => {
    const adapter = createXAdapter();
    const tools = await adapter.listTools({ page: {} as never });
    const compose = tools.find((tool) => tool.name === "tweet.create");

    expect(compose?.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["text"],
      }),
    );
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "timeline.home.list",
        "timeline.user.list",
        "search.tweets.list",
        "tweet.get",
        "favorites.list",
        "user.get",
      ]),
    );
  });

  it("returns auth required for timeline reads when logged out", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      authState: "auth_required",
      authSignals: ["login_ui"],
    });

    const result = await adapter.callTool({ name: "timeline.home.list", input: {} }, { page: page as never });

    expect(result).toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "login required",
        details: {
          state: "auth_required",
          signals: ["login_ui"],
        },
      },
    });
  });

  it("returns challenge required for compose when x challenge blocks actions", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      authState: "challenge_required",
      authSignals: ["challenge_ui"],
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "CHALLENGE_REQUIRED",
        message: "x.com challenge is blocking actions",
        details: {
          state: "challenge_required",
          signals: ["challenge_ui"],
        },
      },
    });
  });

  it("supports dry-run compose without waiting confirmation", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      composeResult: { ok: true, dryRun: true, submitVisible: true },
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello", dryRun: true } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      submitVisible: true,
    });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("fails closed when compose submit cannot be confirmed", async () => {
    const adapter = createXAdapter({ composeConfirmTimeoutMs: 100 });
    const { page } = createMockPage({
      composeResult: { ok: true },
      confirmCompose: false,
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "ACTION_UNCONFIRMED",
        message: "post submit was not confirmed in timeline",
      },
    });
  });

  it("returns confirmed compose result when timeline confirms post", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      composeResult: { ok: true },
      confirmCompose: true,
      statusUrl: "https://x.com/example/status/999",
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      confirmed: true,
      statusUrl: "https://x.com/example/status/999",
    });
  });

  it("returns validation error for tweet.get without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "tweet.get", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });

  it("reuses cached read page across favorites.list calls", async () => {
    const adapter = createXAdapter();
    const { page, newPage } = createMockPage();

    const first = await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });
    const second = await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });

    expect(newPage).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      source: "network",
      hasMore: true,
      nextCursor: "cursor-next",
    });
    expect(second).toMatchObject({
      source: "network",
    });
  });

  it("uses process-level template cache when capture is unavailable", async () => {
    const adapter = createXAdapter();
    const { page, behavior } = createMockPage();

    await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });
    behavior.requireFallbackTemplate = true;
    const second = await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });

    expect(second).toMatchObject({
      source: "network",
    });
  });

  it("returns validation error for timeline.user.list without username", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "timeline.user.list", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "username is required",
      },
    });
  });

  it("reads user timeline with cursor pagination", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      timelineItems: [{ id: "u-1", text: "user timeline card", url: "https://x.com/a/status/1" }],
      networkNextCursor: "user-next",
    });

    const result = await adapter.callTool(
      { name: "timeline.user.list", input: { username: "jack", limit: 1, cursor: "prev-user" } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/jack", expect.anything());
    expect(result).toMatchObject({
      source: "network",
      hasMore: true,
      nextCursor: "user-next",
      items: [{ id: "u-1", text: "user timeline card" }],
    });
  });

  it("reads search timeline with latest mode by default", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      timelineItems: [{ id: "s-1", text: "search result", url: "https://x.com/a/status/2" }],
      networkNextCursor: "search-next",
    });

    const result = await adapter.callTool(
      { name: "search.tweets.list", input: { query: "playwright", limit: 1 } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("https://x.com/search?q=playwright"),
      expect.anything(),
    );
    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("f=live"),
      expect.anything(),
    );
    expect(result).toMatchObject({
      source: "network",
      hasMore: true,
      nextCursor: "search-next",
      items: [{ id: "s-1", text: "search result" }],
    });
  });

  it("reads search timeline with top mode", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage();

    await adapter.callTool(
      { name: "search.tweets.list", input: { query: "typescript", mode: "top", limit: 1 } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("https://x.com/search?q=typescript"),
      expect.anything(),
    );
    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("f=top"),
      expect.anything(),
    );
  });
});
