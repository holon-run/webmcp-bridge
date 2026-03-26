/**
 * This module tests adapter-weibo schema validation and DOM-oriented read tool behavior.
 * It depends on the adapter factory and page-like mocks so Weibo contract coverage stays deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdapter, manifest } from "../src/index.js";

function createMockPage(options?: {
  url?: string;
  title?: string;
  authState?: "authenticated" | "auth_required" | "challenge_required";
  authSignals?: string[];
  timelineBatches?: Array<Array<Record<string, unknown>>>;
  networkTimelineItems?: Array<Record<string, unknown>>;
  post?: Record<string, unknown>;
  networkPost?: Record<string, unknown>;
  user?: Record<string, unknown>;
  aiSummary?: Record<string, unknown>;
  composeResult?: { ok: boolean; dryRun?: boolean; reason?: string; submitVisible?: boolean };
  commentComposeResult?: { ok: boolean; dryRun?: boolean; reason?: string; submitVisible?: boolean };
  postConfirmation?: { confirmed: boolean; url?: string };
  commentConfirmation?: { confirmed: boolean; url?: string };
  articleDrafts?: Array<Record<string, unknown>>;
  articleDraft?: Record<string, unknown>;
  childUrl?: string;
  coverLibraryItems?: number;
}) {
  let timelinePass = 0;
  let coverLibraryCount = options?.coverLibraryItems ?? 0;
  let coverSelectionEnabled = false;
  const makeLocator = (selector: string) => {
    if (selector === ".cover-preview" || selector === ".cover-preview .mask") {
      return {
        first: () => ({
          count: vi.fn(async () => (options?.coverLibraryItems !== undefined ? 1 : 0)),
          click: vi.fn(async () => {}),
        }),
      };
    }
    if (selector === ".image-list .image-item") {
      return {
        count: vi.fn(async () => coverLibraryCount),
        nth: (_index: number) => ({
          count: vi.fn(async () => (coverLibraryCount > 0 ? 1 : 0)),
          click: vi.fn(async () => {
            if (coverLibraryCount > 0) {
              coverSelectionEnabled = true;
            }
          }),
        }),
      };
    }
    if (selector === "input[type='file']") {
      return {
        first: () => ({
          count: vi.fn(async () => (options?.coverLibraryItems !== undefined ? 1 : 0)),
          setInputFiles: vi.fn(async () => {
            coverLibraryCount += 1;
          }),
        }),
        last: () => ({
          count: vi.fn(async () => (options?.coverLibraryItems !== undefined ? 1 : 0)),
          setInputFiles: vi.fn(async () => {
            coverLibraryCount += 1;
          }),
        }),
      };
    }
    return {
      first: () => ({
        count: vi.fn(async () => 0),
        click: vi.fn(async () => {}),
        setInputFiles: vi.fn(async () => {}),
      }),
      last: () => ({
        count: vi.fn(async () => 0),
        click: vi.fn(async () => {}),
        setInputFiles: vi.fn(async () => {}),
        isDisabled: vi.fn(async () => !coverSelectionEnabled),
      }),
      nth: (_index: number) => ({
        count: vi.fn(async () => 0),
        click: vi.fn(async () => {}),
      }),
      count: vi.fn(async () => 0),
    };
  };
  const makeTextLocator = (text: string) => ({
    first: () => ({
      count: vi.fn(async () => {
        if (options?.coverLibraryItems === undefined) {
          return 1;
        }
        return ["图片库", "上传", "下一步", "取消"].includes(text) ? 1 : 1;
      }),
      click: vi.fn(async () => {}),
    }),
    last: () => ({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {}),
      isDisabled: vi.fn(async () => (text.includes("下一步") ? !coverSelectionEnabled : false)),
    }),
  });
  const page: {
    addInitScript: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    title: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
    waitForLoadState: ReturnType<typeof vi.fn>;
    waitForFunction: ReturnType<typeof vi.fn>;
    waitForEvent: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
    getByText: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    context?: ReturnType<typeof vi.fn>;
    __childPage?: {
      goto: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      url: ReturnType<typeof vi.fn>;
      isClosed: ReturnType<typeof vi.fn>;
      waitForLoadState: ReturnType<typeof vi.fn>;
      waitForFunction: ReturnType<typeof vi.fn>;
      waitForEvent: ReturnType<typeof vi.fn>;
      locator: ReturnType<typeof vi.fn>;
      getByText: ReturnType<typeof vi.fn>;
    };
    __newPageMock?: ReturnType<typeof vi.fn>;
  } = {
    addInitScript: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    url: vi.fn(() => options?.url ?? "https://weibo.com"),
    title: vi.fn(async () => options?.title ?? "微博"),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    waitForEvent: vi.fn(async () => null),
    locator: vi.fn((selector: string) => makeLocator(selector)),
    getByText: vi.fn((text: string) => makeTextLocator(text)),
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
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "compose_post") {
        return options?.composeResult ?? { ok: true };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "confirm_post") {
        return options?.postConfirmation ?? { confirmed: true, url: "https://weibo.com/detail/mock-post" };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "compose_comment") {
        return options?.commentComposeResult ?? { ok: true };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "confirm_comment") {
        return options?.commentConfirmation ?? { confirmed: true, url: "https://weibo.com/detail/mock-comment" };
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "labels" in arg) {
        return true;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "placeholderNeedle" in arg && "value" in arg) {
        return true;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "html" in arg) {
        return true;
      }
      if (arg === undefined) {
        return options?.articleDrafts ?? true;
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
    url: vi.fn(() => options?.childUrl ?? options?.url ?? "https://weibo.com"),
    title: vi.fn(async () => options?.title ?? "微博"),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    waitForEvent: vi.fn(async () => null),
    locator: vi.fn((selector: string) => makeLocator(selector)),
    getByText: vi.fn((text: string) => makeTextLocator(text)),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "labels" in arg) {
        return true;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "placeholderNeedle" in arg && "value" in arg) {
        return true;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && "html" in arg) {
        return true;
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
  const articleDrafts = options?.articleDrafts ?? [
    { id: "168782", title: "现有草稿", updatedAt: "2026-03-25 22:45", editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782", active: true },
  ];
  const articleDraft = options?.articleDraft ?? {
    id: "168782",
    title: "现有草稿",
    lead: "草稿导语",
    bodyText: "草稿正文",
    bodyHtml: "<p>草稿正文</p>",
    wordCount: 4,
    editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
  };
  page.evaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
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
    if (
      arg
      && typeof arg === "object"
      && !Array.isArray(arg)
      && "inputLimit" in arg
      && "inputCursor" in arg
      && "fallbackTemplate" in arg
      && "headerAllowlist" in arg
      && options?.networkTimelineItems
    ) {
      return {
        source: "network",
        items: options.networkTimelineItems,
        selectedTemplate: {
          url: "https://weibo.com/ajax/feed/unreadfriendstimeline?since_id=0",
          method: "GET",
          headers: {},
        },
      };
    }
    if (
      arg
      && typeof arg === "object"
      && !Array.isArray(arg)
      && "ids" in arg
      && Array.isArray(arg.ids)
      && options?.networkPost
    ) {
      const ids = arg.ids as string[];
      return ids.reduce<Record<string, Record<string, unknown>>>((result, id) => {
        result[id] = options.networkPost as Record<string, unknown>;
        return result;
      }, {});
    }
    if (
      arg
      && typeof arg === "object"
      && !Array.isArray(arg)
      && "inputId" in arg
      && "fallbackTemplate" in arg
      && "headerAllowlist" in arg
      && !("inputCursor" in arg)
      && options?.networkPost
    ) {
      return {
        source: "network",
        post: options.networkPost,
        selectedTemplate: {
          url: "https://weibo.com/ajax/statuses/show?id=0",
          method: "GET",
          headers: {},
        },
      };
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "compose_post") {
      return options?.composeResult ?? { ok: true };
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "confirm_post") {
      return options?.postConfirmation ?? { confirmed: true, url: "https://weibo.com/detail/mock-post" };
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "compose_comment") {
      return options?.commentComposeResult ?? { ok: true };
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "confirm_comment") {
      return options?.commentConfirmation ?? { confirmed: true, url: "https://weibo.com/detail/mock-comment" };
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "inputQuery" in arg) {
      return { source: "dom", reason: "request_failed" };
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "labels" in arg) {
      return true;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "placeholderNeedle" in arg && "value" in arg) {
      return true;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "html" in arg) {
      return true;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_ai_search") {
      return options?.aiSummary;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_article_drafts") {
      return articleDrafts;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "extract_article_draft") {
      return articleDraft;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg) && "op" in arg && arg.op === "article_publish_ready") {
      return true;
    }
    if (arg === undefined) {
      return true;
    }
    return undefined;
  });
  childPage.evaluate = page.evaluate;
  const newPageMock = vi.fn(async () => childPage);
  page.context = vi.fn(() => ({
    newPage: newPageMock,
    request: undefined,
  }));
  return Object.assign(page, { __childPage: childPage, __newPageMock: newPageMock });
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

  it("supports dry-run post compose without submitting", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      composeResult: { ok: true, dryRun: true, submitVisible: true },
    });

    await expect(
      adapter.callTool({ name: "post.create", input: { text: "hello weibo", dryRun: true } }, { page: page as never }),
    ).resolves.toEqual({
      ok: true,
      dryRun: true,
      submitVisible: true,
    });
  });

  it("returns confirmed post compose result", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      composeResult: { ok: true },
      postConfirmation: { confirmed: true, url: "https://weibo.com/detail/new-post" },
    });

    await expect(
      adapter.callTool({ name: "post.create", input: { text: "hello weibo" } }, { page: page as never }),
    ).resolves.toEqual({
      ok: true,
      confirmed: true,
      url: "https://weibo.com/detail/new-post",
    });
  });

  it("supports dry-run comment compose without submitting", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      commentComposeResult: { ok: true, dryRun: true, submitVisible: true },
    });

    await expect(
      adapter.callTool(
        { name: "comment.create", input: { id: "m1", text: "hello comment", dryRun: true } },
        { page: page as never },
      ),
    ).resolves.toEqual({
      ok: true,
      dryRun: true,
      submitVisible: true,
      commentToUrl: "https://weibo.com/detail/m1",
    });
  });

  it("returns confirmed comment result", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      commentComposeResult: { ok: true },
      commentConfirmation: { confirmed: true, url: "https://weibo.com/detail/m1" },
    });

    await expect(
      adapter.callTool(
        { name: "comment.create", input: { id: "m1", text: "hello comment" } },
        { page: page as never },
      ),
    ).resolves.toEqual({
      ok: true,
      confirmed: true,
      commentToUrl: "https://weibo.com/detail/m1",
      url: "https://weibo.com/detail/m1",
    });
  });

  it("hydrates long text items in network timeline reads", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      networkTimelineItems: [
        {
          id: "5272327174494361",
          text_raw: "截断微博 一 ​​​",
          isLongText: true,
          user: {
            screen_name: "jolestar",
            profile_url: "/u/1648815335",
          },
        },
      ],
      networkPost: {
        id: "5272327174494361",
        text_raw: "截断微博 一 ​​​",
        longTextContent_raw: "这是 timeline 返回时需要补抓的完整长微博正文。",
        user: {
          screen_name: "jolestar",
          profile_url: "/u/1648815335",
        },
      },
    });

    await expect(
      adapter.callTool({ name: "timeline.home.list", input: { limit: 1 } }, { page: page as never }),
    ).resolves.toEqual({
      items: [
        {
          id: "5272327174494361",
          text: "这是 timeline 返回时需要补抓的完整长微博正文。",
          authorName: "jolestar",
          authorUrl: "https://weibo.com/u/1648815335",
          url: "https://weibo.com/jolestar/5272327174494361",
        },
      ],
      hasMore: false,
      source: "network",
    });
  });

  it("lists visible article drafts from the editor sidebar", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      childUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
      articleDrafts: [
        {
          id: "168782",
          title: "现有草稿",
          updatedAt: "2026-03-25 22:45",
          editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
          active: true,
        },
        {
          title: "旧草稿",
          updatedAt: "2018-03-21 16:46",
        },
      ],
    });

    await expect(
      adapter.callTool({ name: "article.listDrafts", input: {} }, { page: page as never }),
    ).resolves.toEqual({
      items: [
        {
          id: "168782",
          title: "现有草稿",
          updatedAt: "2026-03-25 22:45",
          editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
          active: true,
        },
        {
          title: "旧草稿",
          updatedAt: "2018-03-21 16:46",
        },
      ],
      source: "dom",
    });
  });

  it("reads the current article draft from the editor", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      childUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
      articleDraft: {
        id: "168782",
        title: "现有草稿",
        lead: "草稿导语",
        bodyText: "草稿正文",
        bodyHtml: "<p>草稿正文</p>",
        wordCount: 4,
        editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
      },
    });

    await expect(
      adapter.callTool({ name: "article.getDraft", input: { draftId: "168782" } }, { page: page as never }),
    ).resolves.toEqual({
      draft: {
        id: "168782",
        title: "现有草稿",
        lead: "草稿导语",
        bodyText: "草稿正文",
        bodyHtml: "<p>草稿正文</p>",
        wordCount: 4,
        editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
      },
      source: "dom",
    });
  });

  it("creates an article draft from markdown", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      childUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
    });
    const tempDir = await mkdtemp(join(tmpdir(), "adapter-weibo-article-"));
    const markdownPath = join(tempDir, "draft.md");
    await writeFile(markdownPath, "# 测试文章\n\n这是一段正文。", "utf8");

    try {
      await expect(
        adapter.callTool({ name: "article.draftMarkdown", input: { markdownPath } }, { page: page as never }),
      ).resolves.toEqual({
        ok: true,
        title: "测试文章",
        lead: "这是一段正文。",
        editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
        draftId: "168782",
        saved: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports dry-run article publish without clicking the final publish button", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      childUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
    });
    const tempDir = await mkdtemp(join(tmpdir(), "adapter-weibo-article-"));
    const markdownPath = join(tempDir, "publish.md");
    await writeFile(markdownPath, "# 发布测试\n\n这是一段正文。", "utf8");

    try {
      await expect(
        adapter.callTool({ name: "article.publishMarkdown", input: { markdownPath, dryRun: true } }, { page: page as never }),
      ).resolves.toEqual({
        ok: true,
        title: "发布测试",
        lead: "这是一段正文。",
        editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
        draftId: "168782",
        saved: true,
        dryRun: true,
        canPublish: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports dry-run article publish with a cover image upload", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      childUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
      coverLibraryItems: 2,
    });
    const tempDir = await mkdtemp(join(tmpdir(), "adapter-weibo-article-"));
    const markdownPath = join(tempDir, "publish-cover.md");
    const coverPath = join(tempDir, "cover.png");
    await writeFile(markdownPath, "# 封面发布测试\n\n这是一段正文。", "utf8");
    await writeFile(coverPath, "fake-image", "utf8");

    try {
      await expect(
        adapter.callTool(
          { name: "article.publishMarkdown", input: { markdownPath, coverImagePath: coverPath, dryRun: true } },
          { page: page as never },
        ),
      ).resolves.toEqual({
        ok: true,
        title: "封面发布测试",
        lead: "这是一段正文。",
        editUrl: "https://card.weibo.com/article/v5/editor#/draft/168782",
        draftId: "168782",
        saved: true,
        hasCoverImage: true,
        dryRun: true,
        canPublish: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses one cached read page across repeated timeline warmups", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      timelineBatches: [[{ id: "m1", text: "第一条微博" }]],
    });

    await adapter.callTool({ name: "timeline.home.list", input: { limit: 1 } }, { page: page as never });
    await adapter.callTool({ name: "timeline.home.list", input: { limit: 1 } }, { page: page as never });

    expect((page as typeof page & { __newPageMock: ReturnType<typeof vi.fn> }).__newPageMock).toHaveBeenCalledTimes(1);
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

  it("prefers long text content for long posts", async () => {
    const adapter = createAdapter();
    const page = createMockPage({
      networkPost: {
        id: "5272327174494361",
        text_raw: "截断微博 一 ​​​",
        longTextContent_raw: "这是完整长微博正文，应该优先返回这一段，而不是截断版本。",
        user: {
          screen_name: "jolestar",
          profile_url: "/u/1648815335",
        },
      },
    });

    await expect(
      adapter.callTool({ name: "post.get", input: { id: "5272327174494361" } }, { page: page as never }),
    ).resolves.toEqual({
      post: {
        id: "5272327174494361",
        text: "这是完整长微博正文，应该优先返回这一段，而不是截断版本。",
        authorName: "jolestar",
        authorUrl: "https://weibo.com/u/1648815335",
        url: "https://weibo.com/jolestar/5272327174494361",
      },
      source: "network",
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
    expect((page as typeof page & { __childPage: { goto: ReturnType<typeof vi.fn> } }).__childPage.goto).toHaveBeenCalledWith("https://s.weibo.com/weibo?q=OpenAI&Refer=weibo_weibo", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
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
