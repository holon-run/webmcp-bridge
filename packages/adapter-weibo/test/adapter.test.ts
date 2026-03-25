/**
 * This module tests adapter-weibo schema validation and DOM-oriented read tool behavior.
 * It depends on the adapter factory and page-like mocks so Weibo contract coverage stays deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { createAdapter, manifest } from "../src/index.js";

function createMockPage(options?: {
  url?: string;
  title?: string;
  authState?: "authenticated" | "auth_required" | "challenge_required";
  authSignals?: string[];
  timelineBatches?: Array<Array<Record<string, unknown>>>;
  post?: Record<string, unknown>;
  user?: Record<string, unknown>;
  aiSummary?: Record<string, unknown>;
}) {
  let timelinePass = 0;
  const page: {
    addInitScript: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    title: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    context?: ReturnType<typeof vi.fn>;
    __childPage?: {
      goto: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  } = {
    addInitScript: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    url: vi.fn(() => options?.url ?? "https://weibo.com"),
    title: vi.fn(async () => options?.title ?? "微博"),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "url" in arg && "title" in arg) {
        return {
          state: options?.authState ?? "authenticated",
          signals: options?.authSignals ?? ["feed-ui"],
        };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "collect_timeline") {
        const timelineArg = arg as unknown as { maxItems: number };
        const batches = options?.timelineBatches ?? [
          [
            { id: "m1", text: "第一条微博", url: "https://weibo.com/detail/m1", authorName: "alice" },
            { id: "m2", text: "第二条微博", url: "https://weibo.com/detail/m2", authorName: "bob" },
            { id: "m3", text: "第三条微博", url: "https://weibo.com/detail/m3", authorName: "carol" },
          ],
        ];
        const batch = batches[Math.min(timelinePass, batches.length - 1)] ?? [];
        timelinePass += 1;
        return batch.slice(0, timelineArg.maxItems);
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_post") {
        return options?.post;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_comments") {
        const timelineArg = arg as unknown as { maxItems: number };
        const batches = options?.timelineBatches ?? [];
        const batch = batches[0] ?? [];
        return batch.slice(0, timelineArg.maxItems);
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_reposts") {
        const timelineArg = arg as unknown as { maxItems: number };
        const batches = options?.timelineBatches ?? [];
        const batch = batches[0] ?? [];
        return batch.slice(0, timelineArg.maxItems);
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_search_results") {
        const timelineArg = arg as unknown as { maxItems: number };
        const batches = options?.timelineBatches ?? [];
        const batch = batches[0] ?? [];
        return batch.slice(0, timelineArg.maxItems);
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_user") {
        return options?.user;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "inputQuery" in arg) {
        return { source: "dom", reason: "request_failed" };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_ai_search") {
        return options?.aiSummary;
      }
      if (arg === undefined) {
        return true;
      }
      return undefined;
    }),
  };
  const childPage = {
    addInitScript: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    url: vi.fn(() => options?.url ?? "https://weibo.com"),
    title: vi.fn(async () => options?.title ?? "微博"),
    waitForTimeout: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    evaluate: page.evaluate,
  };
  page.context = vi.fn(() => ({
    newPage: vi.fn(async () => childPage),
  }));
  return Object.assign(page, { __childPage: childPage });
}

describe("adapter-weibo manifest", () => {
  it("exports the expected host policy", () => {
    expect(manifest.defaultUrl).toBe("https://weibo.com");
    expect(manifest.hostPatterns).toContain("weibo.com");
    expect(manifest.authPolicy).toEqual({
      mode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
    });
  });
});

describe("createAdapter", () => {
  it("reports auth_required from the auth probe", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      url: "https://passport.weibo.com/login",
      title: "微博登录",
      authState: "auth_required",
      authSignals: ["login-host", "password-input"],
    });

    await expect(adapter.callTool({ name: "auth.get", input: {} }, { page: page as never })).resolves.toEqual({
      state: "auth_required",
      signals: ["login-host", "password-input"],
      url: "https://passport.weibo.com/login",
      title: "微博登录",
      source: "adapter-weibo",
    });
  });

  it("lists home timeline cards with adapter cursors", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      timelineBatches: [
        [
          { id: "m1", text: "第一条微博" },
          { id: "m2", text: "第二条微博" },
          { id: "m3", text: "第三条微博" },
        ],
      ],
    });

    await expect(
      adapter.callTool({ name: "timeline.home.list", input: { limit: 2 } }, { page: page as never }),
    ).resolves.toEqual({
      items: [
        { id: "m1", text: "第一条微博" },
        { id: "m2", text: "第二条微博" },
      ],
      hasMore: true,
      nextCursor: "dom:2",
      source: "dom",
    });
    expect(page.goto).not.toHaveBeenCalledWith("https://weibo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    expect((page as typeof page & { __childPage: { goto: ReturnType<typeof vi.fn> } }).__childPage.goto).toHaveBeenCalledWith("https://weibo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  });

  it("rejects malformed timeline cursors", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(
      adapter.callTool(
        { name: "timeline.home.list", input: { cursor: "dom:bad-cursor" } },
        { page: page as never },
      ),
    ).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "cursor must be a previous nextCursor value or dom:<offset>",
      },
    });
  });

  it("gates read tools when sign-in is required", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      authState: "auth_required",
      authSignals: ["login-ui"],
    });

    await expect(
      adapter.callTool({ name: "timeline.home.list", input: {} }, { page: page as never }),
    ).resolves.toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "interactive Weibo sign-in is required in the browser session",
      },
    });
  });

  it("validates allowed hosts for post reads", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(
      adapter.callTool(
        { name: "post.get", input: { url: "https://example.com/not-allowed" } },
        { page: page as never },
      ),
    ).resolves.toEqual({
      error: {
        code: "URL_NOT_ALLOWED",
        message: "url must stay within weibo.com hosts",
      },
    });
  });

  it("returns a visible post after navigating to detail", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      post: {
        id: "m1",
        text: "详情页微博",
        url: "https://weibo.com/detail/m1",
        authorName: "alice",
      },
    });

    await expect(
      adapter.callTool({ name: "post.get", input: { id: "m1" } }, { page: page as never }),
    ).resolves.toEqual({
      post: {
        id: "m1",
        text: "详情页微博",
        url: "https://weibo.com/detail/m1",
        authorName: "alice",
      },
      source: "dom",
    });
    expect(page.goto).toHaveBeenCalledWith("https://weibo.com/detail/m1", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  });

  it("lists post replies with DOM fallback", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      timelineBatches: [
        [
          { id: "c1", text: "第一条评论" },
          { id: "c2", text: "第二条评论" },
        ],
      ],
    });

    await expect(
      adapter.callTool({ name: "post.replies.list", input: { id: "m1" } }, { page: page as never }),
    ).resolves.toEqual({
      items: [
        { id: "c1", text: "第一条评论" },
        { id: "c2", text: "第二条评论" },
      ],
      hasMore: false,
      source: "dom",
    });
  });

  it("lists post reposts with DOM fallback", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      timelineBatches: [
        [
          { id: "r1", text: "第一条转发" },
          { id: "r2", text: "第二条转发" },
        ],
      ],
    });

    await expect(
      adapter.callTool({ name: "post.repost.list", input: { id: "m1" } }, { page: page as never }),
    ).resolves.toEqual({
      items: [
        { id: "r1", text: "第一条转发" },
        { id: "r2", text: "第二条转发" },
      ],
      hasMore: false,
      source: "dom",
    });
  });

  it("returns a visible user profile after navigating to profile", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      user: {
        id: "123",
        screenName: "alice",
        profileUrl: "https://weibo.com/u/123",
      },
    });

    await expect(
      adapter.callTool({ name: "user.get", input: { screenName: "alice" } }, { page: page as never }),
    ).resolves.toEqual({
      user: {
        id: "123",
        screenName: "alice",
        profileUrl: "https://weibo.com/u/123",
      },
      source: "dom",
    });
    expect(page.goto).toHaveBeenCalledWith("https://weibo.com/n/alice", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  });

  it("lists user posts through uid input", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      timelineBatches: [
        [
          { id: "m1", text: "第一条微博" },
          { id: "m2", text: "第二条微博" },
        ],
      ],
    });

    await expect(
      adapter.callTool({ name: "user.posts.list", input: { uid: "123" } }, { page: page as never }),
    ).resolves.toEqual({
      items: [
        { id: "m1", text: "第一条微博" },
        { id: "m2", text: "第二条微博" },
      ],
      hasMore: false,
      source: "dom",
    });
  });

  it("validates user posts page cursor input", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(
      adapter.callTool({ name: "user.posts.list", input: { uid: "123", cursor: "bad-page" } }, { page: page as never }),
    ).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "cursor must be a positive integer page number",
      },
    });
  });

  it("searches weibo via DOM extraction", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      timelineBatches: [
        [
          { id: "s1", text: "OpenAI 相关微博" },
          { id: "s2", text: "第二条搜索结果" },
        ],
      ],
    });

    await expect(
      adapter.callTool({ name: "search.weibo", input: { query: "OpenAI", limit: 2 } }, { page: page as never }),
    ).resolves.toEqual({
      query: "OpenAI",
      items: [
        { id: "s1", text: "OpenAI 相关微博" },
        { id: "s2", text: "第二条搜索结果" },
      ],
      hasMore: true,
      nextCursor: "2",
      source: "dom",
    });
  });

  it("validates search query input", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(
      adapter.callTool({ name: "search.weibo", input: {} }, { page: page as never }),
    ).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "query is required",
      },
    });
  });

  it("reads ai search summary with DOM fallback", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      aiSummary: {
        query: "OpenAI",
        displayQuery: "OpenAI",
        summary: "这是 AI 搜索摘要。",
        format: "text",
      },
    });

    await expect(
      adapter.callTool({ name: "search.ai.summary", input: { query: "OpenAI" } }, { page: page as never }),
    ).resolves.toEqual({
      query: "OpenAI",
      displayQuery: "OpenAI",
      summary: "这是 AI 搜索摘要。",
      format: "text",
      source: "dom",
      reason: "request_failed",
    });
  });

  it("returns ai search metadata even when summary text is unavailable", async () => {
    const adapter = createAdapter();
    const page = createMockPage();
    page.evaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "url" in arg && "title" in arg) {
        return {
          state: "authenticated",
          signals: ["feed-ui"],
        };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "inputQuery" in arg) {
        return {
          source: "network",
          reason: "summary_unavailable",
          result: {
            query: "OpenAI",
            displayQuery: "OpenAI",
            format: "markdown",
            status: 1,
            qsStatus: 0,
            statusStage: 0,
          },
        };
      }
      return undefined;
    });

    await expect(
      adapter.callTool({ name: "search.ai.summary", input: { query: "OpenAI" } }, { page: page as never }),
    ).resolves.toEqual({
      query: "OpenAI",
      displayQuery: "OpenAI",
      format: "markdown",
      status: 1,
      qsStatus: 0,
      statusStage: 0,
      source: "network",
      reason: "summary_unavailable",
    });
  });

  it("validates ai search query input", async () => {
    const adapter = createAdapter();
    const page = createMockPage();

    await expect(
      adapter.callTool({ name: "search.ai.summary", input: {} }, { page: page as never }),
    ).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "query is required",
      },
    });
  });
});
