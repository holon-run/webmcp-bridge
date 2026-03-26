/**
 * This module implements the Weibo fallback adapter with browser-side auth checks and read tools.
 * It depends on Playwright page evaluation and shared adapter contracts so local-mcp can bridge Weibo reads through network-first execution with DOM fallback.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { SiteAdapter, WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import {
  buildRequestCaptureInitScript,
  type RequestTemplate,
  TemplateCache,
} from "@webmcp-bridge/adapter-utils";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { Page } from "playwright";

type WeiboAuthState = "authenticated" | "auth_required" | "challenge_required";

type AuthProbeResult = {
  state: WeiboAuthState;
  signals: string[];
  url: string;
  title: string;
};

type TimelineItem = {
  id: string;
  url?: string;
  text: string;
  authorName?: string;
  authorUrl?: string;
  createdAt?: string;
};

type UserProfile = {
  id?: string;
  screenName?: string;
  profileUrl?: string;
  description?: string;
  followersCount?: string;
  followsCount?: string;
};

type AiSearchSummary = {
  query: string;
  displayQuery?: string;
  summary?: string;
  format?: string;
  status?: number;
  qsStatus?: number;
  statusStage?: number;
  referenceCount?: number;
  relatedPostIds?: string[];
};

type WeiboReadSource = "network" | "dom";

type WeiboComposeDomResult = {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  submitVisible?: boolean;
};

type WeiboComposeConfirmation = {
  confirmed: boolean;
  url?: string;
};

type WeiboArticleDraftSummary = {
  id?: string;
  title: string;
  updatedAt?: string;
  editUrl?: string;
  active?: boolean;
};

type WeiboArticleDraft = WeiboArticleDraftSummary & {
  lead?: string;
  bodyText?: string;
  bodyHtml?: string;
  wordCount?: number;
  hasCoverImage?: boolean;
};

type ArticleAttachment = {
  path: string;
  name: string;
};

type NormalizedArticleMarkdown = {
  title: string;
  bodyMarkdown: string;
};

type PreparedArticleMarkdown = {
  markdown: string;
  html: string;
  lead?: string;
};

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 20;
const MAX_HOME_SCROLL_PASSES = 4;
const DEFAULT_WRITE_CONFIRM_TIMEOUT_MS = 10_000;
const LEGACY_DOM_CURSOR_PREFIX = "dom:";
const WEIBO_ALLOWED_HOSTS = new Set(["weibo.com", "www.weibo.com", "m.weibo.cn"]);
const TEMPLATE_HEADER_ALLOWLIST = ["x-xsrf-token", "client-version", "x-requested-with", "content-type"] as const;
const HOME_TIMELINE_URL = "https://weibo.com/";
const WEIBO_ARTICLE_EDITOR_URL = "https://card.weibo.com/article/v3/editor";

type WeiboTemplateBucket =
  | "timeline.home.list"
  | "post.get"
  | "post.replies.list"
  | "post.repost.list"
  | "user.get"
  | "user.posts.list";

const PROCESS_TEMPLATE_CACHE = new TemplateCache<WeiboTemplateBucket, RequestTemplate>();
const READ_PAGE_CACHE = new WeakMap<Page, Page>();

const CAPTURE_INJECT_SCRIPT = buildRequestCaptureInitScript({
  globalKey: "__WEBMCP_WEIBO_CAPTURE__",
  shouldCaptureSource: String.raw`((url) => {
    if (typeof url !== "string") return false;
    return (
      url.includes("/ajax/feed/unreadfriendstimeline") ||
      url.includes("/ajax/statuses/show") ||
      url.includes("/ajax/profile/info") ||
      url.includes("/ajax/statuses/mymblog") ||
      url.includes("/ajax/statuses/buildComments") ||
      url.includes("/ajax/statuses/repostTimeline")
    );
  })`,
  enrichEntrySource: String.raw`((entry) => {
    const url = typeof entry?.url === "string" ? entry.url : "";
    let op = "unknown";
    if (url.includes("/ajax/feed/unreadfriendstimeline")) op = "timeline.home.list";
    else if (url.includes("/ajax/statuses/show")) op = "post.get";
    else if (url.includes("/ajax/statuses/buildComments")) op = "post.replies.list";
    else if (url.includes("/ajax/statuses/repostTimeline")) op = "post.repost.list";
    else if (url.includes("/ajax/profile/info")) op = "user.get";
    else if (url.includes("/ajax/statuses/mymblog")) op = "user.posts.list";
    return { ...entry, op };
  })`,
  maxEntries: 80,
});

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "auth.get",
    description: "Detect Weibo login or challenge state",
    inputSchema: {
      type: "object",
      description: "No parameters.",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "page.get",
    description: "Return the current browser page URL and title for debugging",
    inputSchema: {
      type: "object",
      description: "No parameters.",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "timeline.home.list",
    description: "Read visible cards from the Weibo home timeline",
    inputSchema: {
      type: "object",
      description: "List items from the logged-in home feed. Network mode uses Weibo max_id cursors; DOM fallback also accepts adapter dom:<offset> cursors.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of items to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Optional pagination cursor from a previous call. Network mode uses Weibo max_id values; legacy DOM fallback also accepts dom:<offset>.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "post.create",
    description: "Publish one Weibo post from the authenticated account",
    inputSchema: {
      type: "object",
      description: "Create a new Weibo post from the current authenticated session.",
      properties: {
        text: {
          type: "string",
          description: "Post text content.",
          minLength: 1,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate the compose path without submitting.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "post.get",
    description: "Read one Weibo post by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch a single visible Weibo post.",
      properties: {
        url: {
          type: "string",
          description: "Absolute Weibo post URL, for example https://weibo.com/123/detail/abcDEF.",
        },
        id: {
          type: "string",
          description: "Weibo post id. Used to build a detail URL when url is omitted.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "comment.create",
    description: "Publish one comment for a Weibo post by url or id",
    inputSchema: {
      type: "object",
      description: "Open a Weibo detail page, compose one comment, and optionally skip final submit with dryRun.",
      properties: {
        url: {
          type: "string",
          description: "Absolute Weibo post URL.",
        },
        id: {
          type: "string",
          description: "Weibo post id. Used to build a detail URL when url is omitted.",
        },
        text: {
          type: "string",
          description: "Comment text content.",
          minLength: 1,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate the comment compose path without submitting.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "article.listDrafts",
    description: "List visible Weibo article drafts from the article editor sidebar",
    inputSchema: {
      type: "object",
      description: "Open the Weibo article editor and read visible drafts from the sidebar.",
      additionalProperties: false,
    },
  },
  {
    name: "article.getDraft",
    description: "Read one Weibo article draft from the editor by draftId or current draft",
    inputSchema: {
      type: "object",
      description: "Open one article draft in the editor and read its current title, lead, and body.",
      properties: {
        draftId: {
          type: "string",
          description: "Optional Weibo article draft id. When omitted, read the current editor draft.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "article.draftMarkdown",
    description: "Create or update a Weibo article draft from a markdown file",
    inputSchema: {
      type: "object",
      description: "Open the Weibo article editor, convert markdown into article content, optionally upload a cover image, and save a draft.",
      properties: {
        markdownPath: {
          type: "string",
          description: "Absolute path to a markdown file.",
        },
        title: {
          type: "string",
          description: "Optional explicit title. Defaults to the first H1 or markdown filename.",
        },
        lead: {
          type: "string",
          description: "Optional lead text. Defaults to the first non-empty paragraph from the markdown body.",
        },
        coverImagePath: {
          type: "string",
          description: "Optional absolute path to a cover image file.",
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate the draft and publish-settings path without saving or publishing.",
        },
      },
      required: ["markdownPath"],
      additionalProperties: false,
    },
  },
  {
    name: "article.publishMarkdown",
    description: "Publish a Weibo article from a markdown file",
    inputSchema: {
      type: "object",
      description: "Open the Weibo article editor, convert markdown into article content, optionally upload a cover image, and publish the article.",
      properties: {
        markdownPath: {
          type: "string",
          description: "Absolute path to a markdown file.",
        },
        title: {
          type: "string",
          description: "Optional explicit title. Defaults to the first H1 or markdown filename.",
        },
        lead: {
          type: "string",
          description: "Optional lead text. Defaults to the first non-empty paragraph from the markdown body.",
        },
        coverImagePath: {
          type: "string",
          description: "Optional absolute path to a cover image file.",
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate the publish path without clicking the final publish button.",
        },
      },
      required: ["markdownPath"],
      additionalProperties: false,
    },
  },
  {
    name: "post.replies.list",
    description: "List visible comments for one Weibo post by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch comments from a Weibo detail page. Network mode uses Weibo max_id cursors.",
      properties: {
        url: {
          type: "string",
          description: "Absolute Weibo post URL.",
        },
        id: {
          type: "string",
          description: "Weibo post id.",
        },
        cursor: {
          type: "string",
          description: "Optional nextCursor returned by a previous post.replies.list call. Network mode uses Weibo max_id values.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "post.repost.list",
    description: "List reposts for one Weibo post by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch reposts from a Weibo detail page. Current network mode uses page-number cursors from the adapter.",
      properties: {
        url: {
          type: "string",
          description: "Absolute Weibo post URL.",
        },
        id: {
          type: "string",
          description: "Weibo post id.",
        },
        cursor: {
          type: "string",
          description: "Optional nextCursor returned by a previous post.repost.list call. Current network mode uses page numbers such as 2 or 3.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "user.get",
    description: "Read one Weibo user profile by url or screen name",
    inputSchema: {
      type: "object",
      description: "Fetch a visible Weibo user profile page.",
      properties: {
        url: {
          type: "string",
          description: "Absolute Weibo profile URL.",
        },
        screenName: {
          type: "string",
          description: "Weibo screen name used to build https://weibo.com/n/<screenName> when url is omitted.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "user.posts.list",
    description: "List Weibo posts for one user profile",
    inputSchema: {
      type: "object",
      description: "Fetch visible posts for one Weibo user. Network mode uses page-based cursors from the adapter.",
      properties: {
        uid: {
          type: "string",
          description: "Weibo numeric user id.",
        },
        url: {
          type: "string",
          description: "Absolute Weibo profile URL.",
        },
        screenName: {
          type: "string",
          description: "Weibo screen name used to build https://weibo.com/n/<screenName> when url is omitted.",
        },
        cursor: {
          type: "string",
          description: "Optional nextCursor returned by a previous user.posts.list call. Current network mode uses page numbers such as 2 or 3.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "search.weibo",
    description: "Search Weibo posts by keyword from the public search results page",
    inputSchema: {
      type: "object",
      description: "Navigate to s.weibo.com and extract visible result cards.",
      properties: {
        query: {
          type: "string",
          description: "Search query text.",
        },
        cursor: {
          type: "string",
          description: "Optional page number cursor returned by a previous search.weibo call.",
        },
        limit: {
          type: "integer",
          description: `Maximum number of result items to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "search.ai.summary",
    description: "Read Weibo AI search summary for one query",
    inputSchema: {
      type: "object",
      description: "Fetch AI summary content from s.weibo.com/aisearch and ai.s.weibo.com.",
      properties: {
        query: {
          type: "string",
          description: "Search query text.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
];

function toRecord(value: JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorResult(code: string, message: string): JsonValue {
  return {
    error: {
      code,
      message,
    },
  };
}

function maybeReason(reason: string | undefined, options?: { includeInvalidResponse?: boolean }): { reason?: string } {
  if (!reason) {
    return {};
  }
  if (!options?.includeInvalidResponse && reason === "invalid_response") {
    return {};
  }
  return { reason };
}

function readNonEmptyString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLimit(input: Record<string, unknown>): number | undefined {
  const value = input.limit;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMELINE_LIMIT) {
    return undefined;
  }
  return value;
}

function readPositivePageCursor(cursor: string | undefined): string | undefined | null {
  if (cursor === undefined) {
    return undefined;
  }
  const value = Number.parseInt(cursor, 10);
  if (!Number.isInteger(value) || value < 1) {
    return null;
  }
  return String(value);
}

function parseCursor(cursor: string | undefined): { kind: "dom"; offset: number } | { kind: "network"; value: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  if (cursor.startsWith(LEGACY_DOM_CURSOR_PREFIX)) {
    const value = Number.parseInt(cursor.slice(LEGACY_DOM_CURSOR_PREFIX.length), 10);
    if (!Number.isInteger(value) || value < 0) {
      return undefined;
    }
    return { kind: "dom", offset: value };
  }
  if (!cursor.trim()) {
    return undefined;
  }
  return { kind: "network", value: cursor.trim() };
}

function isAllowedWeiboUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return WEIBO_ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function buildPostUrl(id: string): string {
  return `https://weibo.com/detail/${encodeURIComponent(id)}`;
}

function buildProfileUrl(screenName: string): string {
  return `https://weibo.com/n/${encodeURIComponent(screenName)}`;
}

function buildArticleEditUrl(draftId?: string): string {
  return draftId
    ? `https://card.weibo.com/article/v5/editor#/draft/${encodeURIComponent(draftId)}`
    : WEIBO_ARTICLE_EDITOR_URL;
}

function parseArticleDraftId(url: string): string | undefined {
  const match = url.match(/#\/draft\/(\d+)/);
  return match?.[1];
}

function parseUserIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/u\/(\d+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function ensureCaptureInstalled(page: Parameters<SiteAdapter["callTool"]>[1]["page"]): Promise<void> {
  if ("addInitScript" in page && typeof page.addInitScript === "function") {
    await page.addInitScript(CAPTURE_INJECT_SCRIPT).catch(() => {});
  }
  await page.evaluate(CAPTURE_INJECT_SCRIPT).catch(() => {});
}

function isSameLocation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname && current.search === target.search;
  } catch {
    return false;
  }
}

async function getOrCreateCachedReadPage(ownerPage: Page, url: string): Promise<Page> {
  const existing = READ_PAGE_CACHE.get(ownerPage);
  if (existing && !existing.isClosed()) {
    if (!isSameLocation(existing.url(), url)) {
      await ensureCaptureInstalled(existing);
      await existing.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    return existing;
  }

  const readPage = await ownerPage.context().newPage();
  await ensureCaptureInstalled(readPage);
  await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  READ_PAGE_CACHE.set(ownerPage, readPage);
  return readPage;
}

async function withCachedReadPage<T>(ownerPage: Page, url: string, run: (readPage: Page) => Promise<T>): Promise<T> {
  const readPage = await getOrCreateCachedReadPage(ownerPage, url);
  return await run(readPage);
}

async function withEphemeralReadPage<T>(ownerPage: Page, url: string, run: (readPage: Page) => Promise<T>): Promise<T> {
  const readPage = await ownerPage.context().newPage();
  try {
    await ensureCaptureInstalled(readPage);
    await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await run(readPage);
  } finally {
    if (!readPage.isClosed()) {
      await readPage.close().catch(() => {});
    }
  }
}

async function withEphemeralPage<T>(ownerPage: Page, url: string, run: (page: Page) => Promise<T>): Promise<T> {
  const nextPage = await ownerPage.context().newPage();
  try {
    await ensureCaptureInstalled(nextPage);
    await nextPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await run(nextPage);
  } finally {
    if (!nextPage.isClosed()) {
      await nextPage.close().catch(() => {});
    }
  }
}

async function closeCachedReadPages(ownerPage: Page): Promise<void> {
  const readPage = READ_PAGE_CACHE.get(ownerPage);
  READ_PAGE_CACHE.delete(ownerPage);
  if (readPage && !readPage.isClosed()) {
    await readPage.close().catch(() => {});
  }
}

function isNavigationRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Execution context was destroyed");
}

async function settleReadPage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});
}

async function retryOnNavigationRace<T>(page: Page, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  const delays = [0, 700, 1_500, 2_500];
  for (const delay of delays) {
    if (delay > 0) {
      await page.waitForTimeout(delay);
      await settleReadPage(page);
    }
    try {
      return await run();
    } catch (error) {
      if (!isNavigationRaceError(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Execution context was destroyed");
}

async function detectAuthState(page: {
  evaluate: <T, Arg = void>(pageFunction: (arg: Arg) => T | Promise<T>, arg?: Arg) => Promise<T>;
  url: () => string;
  title: () => Promise<string>;
}): Promise<AuthProbeResult> {
  const url = page.url();
  const title = await page.title();
  const result = await page.evaluate((input) => {
    const signals: string[] = [];
    const text = document.body?.innerText ?? "";
    const bodyText = text.replace(/\s+/g, " ").trim();
    const lowerUrl = input.url.toLowerCase();
    const lowerTitle = input.title.toLowerCase();

    const hasLoginHost = lowerUrl.includes("passport.weibo.com") || lowerUrl.includes("login.sina.com.cn");
    const hasPasswordInput = Boolean(document.querySelector("input[type='password']"));
    const hasLoginUi = Boolean(
      document.querySelector(".login_box, .woo-panel-login, .gn_login_list, [node-type='loginForm']"),
    );
    const hasChallengeUi = Boolean(
      document.querySelector("input[name='captcha'], input[placeholder*='验证码'], .verify-box, .security_verify"),
    );
    const hasFeedUi = Boolean(
      document.querySelector("[action-type='feed_list_item'], .Feed_wrap, [mid], [node-type='feed_list_content']"),
    );
    const hasComposerUi = Boolean(
      document.querySelector("textarea, [contenteditable='true'], [node-type='publish_editor']"),
    );

    if (hasLoginHost) signals.push("login-host");
    if (hasPasswordInput) signals.push("password-input");
    if (hasLoginUi) signals.push("login-ui");
    if (hasChallengeUi || bodyText.includes("安全验证") || bodyText.includes("验证码")) {
      signals.push("challenge-ui");
    }
    if (hasFeedUi) signals.push("feed-ui");
    if (hasComposerUi) signals.push("composer-ui");
    if (lowerTitle.includes("微博")) signals.push("weibo-title");

    if (signals.includes("challenge-ui")) {
      return { state: "challenge_required" as const, signals };
    }
    if (
      hasLoginHost ||
      hasPasswordInput ||
      hasLoginUi ||
      lowerTitle.includes("登录") ||
      bodyText.includes("扫码登录") ||
      bodyText.includes("登录注册更精彩")
    ) {
      return { state: "auth_required" as const, signals };
    }
    if (hasFeedUi || hasComposerUi || lowerUrl.includes("weibo.com")) {
      return { state: "authenticated" as const, signals };
    }
    return { state: "auth_required" as const, signals };
  }, { url, title });

  return {
    state: result.state,
    signals: result.signals,
    url,
    title,
  };
}

async function ensureAuthenticated(page: Parameters<SiteAdapter["callTool"]>[1]["page"]): Promise<JsonValue | undefined> {
  const auth = await detectAuthState(page);
  if (auth.state === "authenticated") {
    return undefined;
  }
  return errorResult(
    auth.state === "challenge_required" ? "CHALLENGE_REQUIRED" : "AUTH_REQUIRED",
    auth.state === "challenge_required"
      ? "interactive Weibo verification is required in the browser session"
      : "interactive Weibo sign-in is required in the browser session",
  );
}

async function waitForWeiboSurface(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      return (
        document.querySelector("textarea") !== null ||
        document.querySelector("[contenteditable='true']") !== null
      );
    }, undefined, { timeout: 12_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function resolveArticleAttachment(
  value: unknown,
  fieldName: string,
): Promise<{ ok: true; attachment?: ArticleAttachment } | { ok: false; result: JsonValue }> {
  if (value === undefined) {
    return { ok: true };
  }
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", `${fieldName} must be a non-empty string`),
    };
  }
  if (!isAbsolute(path)) {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", `${fieldName} must be an absolute file path`),
    };
  }
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return {
        ok: false,
        result: errorResult("VALIDATION_ERROR", `${fieldName} must point to a file`),
      };
    }
  } catch {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", `${fieldName} was not found`),
    };
  }
  return {
    ok: true,
    attachment: {
      path,
      name: basename(path),
    },
  };
}

function extractArticleTitle(markdown: string, markdownPath: string, explicitTitle?: string): string {
  const title = typeof explicitTitle === "string" ? explicitTitle.trim() : "";
  if (title) {
    return title;
  }
  const headingMatch = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return basename(markdownPath, extname(markdownPath)).trim() || "Untitled";
}

function normalizeArticleTitleForComparison(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeArticleMarkdown(markdown: string, markdownPath: string, explicitTitle?: string): NormalizedArticleMarkdown {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const explicit = typeof explicitTitle === "string" ? explicitTitle.trim() : "";
  const derivedTitle = extractArticleTitle(normalized, markdownPath, explicitTitle);
  const comparisonTitle = normalizeArticleTitleForComparison(derivedTitle);
  const output: string[] = [];
  let insideFence = false;
  let firstH1Handled = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence;
      output.push(line);
      continue;
    }
    if (insideFence) {
      output.push(line);
      continue;
    }
    const match = line.match(/^(\s*)#\s+(.+?)\s*$/);
    if (!match) {
      output.push(line);
      continue;
    }
    const headingText = (match[2] ?? "").trim();
    if (!firstH1Handled) {
      firstH1Handled = true;
      if (!explicit || normalizeArticleTitleForComparison(headingText) === comparisonTitle) {
        continue;
      }
    }
    output.push(`${match[1]}## ${headingText}`);
  }

  return {
    title: derivedTitle,
    bodyMarkdown: output.join("\n").replace(/^\s*\n/, "").trim(),
  };
}

function stripMarkdownImageDestination(rawDestination: string): string {
  const trimmed = rawDestination.trim();
  const withoutAngle = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const titleMatch = withoutAngle.match(/^(.+?)(?:\s+["'(].*)?$/);
  return (titleMatch?.[1] ?? withoutAngle).trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function convertMarkdownInlineToHtml(value: string): string {
  const placeholders: string[] = [];
  const reserve = (html: string): string => {
    const token = `__WEBMCP_HTML_${placeholders.length}__`;
    placeholders.push(html);
    return token;
  };

  let rendered = value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, altRaw: string, destinationRaw: string) => {
      const alt = escapeHtml(altRaw.trim());
      const destination = escapeHtml(stripMarkdownImageDestination(destinationRaw));
      return reserve(`<img src="${destination}" alt="${alt}">`);
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, textRaw: string, hrefRaw: string) => {
      const text = escapeHtml(textRaw.trim() || hrefRaw.trim());
      const href = escapeHtml(hrefRaw.trim());
      return reserve(`<a href="${href}">${text}</a>`);
    })
    .replace(/`([^`]+)`/g, (_match, codeRaw: string) => reserve(`<code>${escapeHtml(codeRaw)}</code>`))
    .replace(/\*\*([^*]+)\*\*/g, (_match, textRaw: string) => reserve(`<strong>${escapeHtml(textRaw)}</strong>`))
    .replace(/\*([^*]+)\*/g, (_match, textRaw: string) => reserve(`<em>${escapeHtml(textRaw)}</em>`));

  rendered = escapeHtml(rendered);
  return rendered.replace(/__WEBMCP_HTML_(\d+)__/g, (_match, indexRaw: string) => {
    const index = Number.parseInt(indexRaw, 10);
    return placeholders[index] ?? "";
  });
}

function convertMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  const flushParagraph = (paragraphLines: string[]) => {
    if (paragraphLines.length === 0) {
      return;
    }
    const text = paragraphLines.join(" ").trim();
    if (!text) {
      return;
    }
    blocks.push(`<p>${convertMarkdownInlineToHtml(text)}</p>`);
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```([^`]*)$/);
    if (fenceMatch) {
      const language = escapeHtml(fenceMatch[1]?.trim() ?? "");
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith("```")) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const code = escapeHtml(codeLines.join("\n"));
      blocks.push(language ? `<pre><code class="language-${language}">${code}</code></pre>` : `<pre><code>${code}</code></pre>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1]!.length);
      const content = convertMarkdownInlineToHtml(headingMatch[2]!.trim());
      blocks.push(`<h${level}>${content}</h${level}>`);
      index += 1;
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const itemLine = lines[index]!.trim();
        const match = itemLine.match(/^[-*+]\s+(.+)$/);
        if (!match) {
          break;
        }
        items.push(`<li>${convertMarkdownInlineToHtml(match[1]!.trim())}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const itemLine = lines[index]!.trim();
        const match = itemLine.match(/^\d+\.\s+(.+)$/);
        if (!match) {
          break;
        }
        items.push(`<li>${convertMarkdownInlineToHtml(match[1]!.trim())}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? "";
      const paragraphTrimmed = paragraphLine.trim();
      if (!paragraphTrimmed) {
        break;
      }
      if (/^```/.test(paragraphTrimmed) || /^(#{1,6})\s+/.test(paragraphTrimmed) || /^[-*+]\s+/.test(paragraphTrimmed) || /^\d+\.\s+/.test(paragraphTrimmed)) {
        break;
      }
      paragraphLines.push(paragraphLine.trim());
      index += 1;
    }
    flushParagraph(paragraphLines);
  }

  return blocks.join("\n");
}

function extractMarkdownLead(markdown: string): string | undefined {
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) {
      continue;
    }
    const normalized = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized) {
      return normalized.slice(0, 140);
    }
  }
  return undefined;
}

function prepareArticleMarkdown(markdown: string, markdownPath: string, explicitLead?: string): PreparedArticleMarkdown {
  const prepared = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, altRaw: string, destinationRaw: string) => {
    const destination = stripMarkdownImageDestination(destinationRaw);
    if (/^(?:https?:|data:)/i.test(destination)) {
      return _match;
    }
    const resolvedPath = isAbsolute(destination) ? destination : resolve(dirname(markdownPath), destination);
    const alt = altRaw.trim();
    return alt ? `![${alt}](${resolvedPath})` : `![](${resolvedPath})`;
  });
  const lead = typeof explicitLead === "string" && explicitLead.trim() ? explicitLead.trim() : extractMarkdownLead(prepared);
  return {
    markdown: prepared,
    html: convertMarkdownToHtml(prepared),
    ...(lead ? { lead } : {}),
  };
}

async function waitForWeiboArticleEditor(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      return (
        document.querySelector("textarea[placeholder*='标题']") !== null &&
        document.querySelector("[contenteditable='true']") !== null
      );
    }, undefined, { timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function extractWeiboArticleDrafts(page: Page): Promise<WeiboArticleDraftSummary[]> {
  return await page.evaluate((input: { op: string }) => {
    void input;
    const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
    const currentDraftId = location.href.match(/#\/draft\/(\d+)/)?.[1];
    const currentTitle =
      compact((document.querySelector<HTMLTextAreaElement>("textarea[placeholder*='标题']")?.value ?? "")) || undefined;
    const items = Array.from(document.querySelectorAll<HTMLElement>(".list-item"));
    return items.flatMap((item) => {
      const text = compact(item.innerText || item.textContent || "");
      if (!text) {
        return [];
      }
      const match = text.match(/^(.*?)(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/);
      const title = compact(match?.[1] ?? text);
      const updatedAt = match?.[2] ? compact(match[2]) : undefined;
      if (!title) {
        return [];
      }
      const active = Boolean(currentTitle && currentTitle === title);
      const output: WeiboArticleDraftSummary = {
        title,
        ...(updatedAt ? { updatedAt } : {}),
        ...(active ? { active: true } : {}),
        ...(active && currentDraftId ? { id: currentDraftId, editUrl: `https://card.weibo.com/article/v5/editor#/draft/${currentDraftId}` } : {}),
      };
      return [output];
    });
  }, { op: "extract_article_drafts" });
}

async function extractWeiboArticleDraft(page: Page): Promise<WeiboArticleDraft | undefined> {
  return await page.evaluate((input: { op: string }) => {
    void input;
    const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
    const title = compact(document.querySelector<HTMLTextAreaElement>("textarea[placeholder*='标题']")?.value ?? "");
    if (!title) {
      return undefined;
    }
    const lead = compact(document.querySelector<HTMLTextAreaElement>("textarea[placeholder*='导语']")?.value ?? "");
    const bodyNode = document.querySelector<HTMLElement>("[contenteditable='true']");
    const bodyText = compact(bodyNode?.innerText ?? "");
    const bodyHtml = typeof bodyNode?.innerHTML === "string" ? bodyNode.innerHTML : "";
    const id = location.href.match(/#\/draft\/(\d+)/)?.[1];
    const output: WeiboArticleDraft = {
      title,
      ...(id ? { id, editUrl: `https://card.weibo.com/article/v5/editor#/draft/${id}` } : {}),
      ...(lead ? { lead } : {}),
      ...(bodyText ? { bodyText } : {}),
      ...(bodyHtml ? { bodyHtml } : {}),
      ...(bodyText ? { wordCount: bodyText.length } : {}),
    };
    return output;
  }, { op: "extract_article_draft" });
}

async function clickTextAction(page: Page, labels: string[]): Promise<boolean> {
  return await page.evaluate((input) => {
    const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
    const elements = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], a, label, span"));
    const target = elements.find((element) => {
      const text = compact(element.innerText || element.textContent || "");
      return text && input.labels.some((label) => text.includes(label));
    });
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, { labels });
}

async function openFreshWeiboArticleEditor(page: Page): Promise<void> {
  await page.goto(WEIBO_ARTICLE_EDITOR_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForWeiboArticleEditor(page);
  await clickTextAction(page, ["写文章"]).catch(() => false);
  await page.waitForTimeout(800);
}

async function setWeiboArticleTextArea(page: Page, placeholderNeedle: string, value: string): Promise<boolean> {
  return await page.evaluate((input) => {
    const element = document.querySelector<HTMLTextAreaElement>(`textarea[placeholder*='${input.placeholderNeedle}']`);
    if (!element) {
      return false;
    }
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) {
      setter.call(element, input.value);
    } else {
      element.value = input.value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { placeholderNeedle, value });
}

async function setWeiboArticleBody(page: Page, html: string): Promise<boolean> {
  return await page.evaluate((input) => {
    const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
    if (!editor) {
      return false;
    }
    editor.focus();
    editor.innerHTML = input.html || "<p></p>";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: "" }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { html });
}

async function saveWeiboArticleDraft(page: Page): Promise<boolean> {
  const clicked = await clickTextAction(page, ["保存草稿"]);
  if (!clicked) {
    return false;
  }
  await page.waitForTimeout(1_200);
  return true;
}

async function advanceWeiboArticlePublishSettings(page: Page): Promise<boolean> {
  const nextClicked = await clickTextAction(page, ["下一步"]);
  if (!nextClicked) {
    return false;
  }
  await page.waitForTimeout(800);
  await clickTextAction(page, ["我同意"]).catch(() => false);
  await page.waitForTimeout(1_500);
  return await page.evaluate((input: { op: string }) => {
    void input;
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    return text.includes("发布设置") || text.includes("设置封面") || text.includes("替换封面图");
  }, { op: "article_publish_ready" }).catch(() => false);
}

async function isWeiboCoverDialogVisible(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    return text.includes("正文图片") && text.includes("图片库") && text.includes("取消");
  }).catch(() => false);
}

async function openWeiboCoverDialog(page: Page): Promise<boolean> {
  const preview = page.locator(".cover-preview").first();
  if (await preview.count().catch(() => 0)) {
    await preview.click({ force: true }).catch(() => {});
  } else {
    const mask = page.locator(".cover-preview .mask").first();
    if (await mask.count().catch(() => 0)) {
      await mask.click({ force: true }).catch(() => {});
    } else {
      return false;
    }
  }
  await page.waitForTimeout(800);
  return await isWeiboCoverDialogVisible(page);
}

async function selectWeiboCoverLibraryItem(page: Page, index: number): Promise<boolean> {
  const item = page.locator(".image-list .image-item").nth(index);
  if (!(await item.count().catch(() => 0))) {
    return false;
  }
  await item.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  const nextButton = page.getByText("下一步", { exact: false }).last();
  return (await nextButton.count().catch(() => 0))
    ? !(await nextButton.isDisabled().catch(() => true))
    : false;
}

async function chooseWeiboCoverFromLibrary(page: Page, coverImagePath: string): Promise<boolean> {
  const dialogOpened = await openWeiboCoverDialog(page);
  if (!dialogOpened) {
    return false;
  }

  const libraryTab = page.getByText("图片库", { exact: false }).first();
  if (await libraryTab.count().catch(() => 0)) {
    await libraryTab.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
  }

  const uploadButton = page.getByText("上传", { exact: false }).first();
  if (await uploadButton.count().catch(() => 0)) {
    await uploadButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const items = page.locator(".image-list .image-item");
  const beforeCount = await items.count().catch(() => 0);
  const input = page.locator("input[type='file']").last();
  if (!(await input.count().catch(() => 0))) {
    return false;
  }
  await input.setInputFiles(coverImagePath).catch(() => {});
  await page.waitForTimeout(1_200);

  const waitForUploadedItem = beforeCount > 0
    ? await page.waitForFunction(
        ({ selector, minCount }) => document.querySelectorAll(selector).length > minCount,
        { selector: ".image-list .image-item", minCount: beforeCount },
        { timeout: 8_000 },
      ).then(() => true)
        .catch(() => false)
    : false;

  const targetIndex = waitForUploadedItem
    ? await items.count().catch(() => beforeCount) - 1
    : Math.max(beforeCount - 1, 0);
  const selected = await selectWeiboCoverLibraryItem(page, targetIndex);
  if (!selected) {
    return false;
  }

  const nextButton = page.getByText("下一步", { exact: false }).last();
  if (await nextButton.count().catch(() => 0)) {
    await nextButton.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(1_500);

  return await page.evaluate(() => {
    const dialogVisible = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    if (dialogVisible.includes("正文图片") && dialogVisible.includes("图片库") && dialogVisible.includes("取消")) {
      return false;
    }
    const coverImage = document.querySelector<HTMLImageElement>(".cover-preview .cover-img");
    return Boolean(coverImage && typeof coverImage.src === "string" && coverImage.src.trim());
  }).catch(() => false);
}

async function uploadWeiboArticleCover(page: Page, coverImagePath: string): Promise<boolean> {
  return await chooseWeiboCoverFromLibrary(page, coverImagePath);
}

async function publishWeiboArticle(page: Page): Promise<{ confirmed: boolean; url?: string }> {
  const clicked = await clickTextAction(page, ["发布"]);
  if (!clicked) {
    return { confirmed: false };
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      const currentUrl = location.href;
      if (!currentUrl.includes("/editor") || text.includes("发布成功")) {
        return currentUrl.startsWith("http")
          ? {
              confirmed: true,
              url: currentUrl,
            }
          : {
              confirmed: true,
            };
      }
      return { confirmed: false };
    }).catch(() => ({ confirmed: false }));
    if (result.confirmed) {
      return result;
    }
    await page.waitForTimeout(600);
  }
  return { confirmed: false };
}

async function createWeiboArticleFromMarkdown(
  page: Page,
  markdownPath: string,
  explicitTitle: string | undefined,
  explicitLead: string | undefined,
  coverImagePath: string | undefined,
  publish: boolean,
  dryRun: boolean,
): Promise<JsonValue> {
  const resolvedMarkdown = await resolveArticleAttachment(markdownPath, "markdownPath");
  if (!resolvedMarkdown.ok || !resolvedMarkdown.attachment) {
    return resolvedMarkdown.ok ? errorResult("VALIDATION_ERROR", "markdownPath was not found") : resolvedMarkdown.result;
  }
  const markdown = await readFile(resolvedMarkdown.attachment.path, "utf8").catch(() => undefined);
  if (markdown === undefined) {
    return errorResult("VALIDATION_ERROR", `markdownPath was not found: ${markdownPath}`);
  }
  const normalized = normalizeArticleMarkdown(markdown, resolvedMarkdown.attachment.path, explicitTitle);
  const prepared = prepareArticleMarkdown(normalized.bodyMarkdown, resolvedMarkdown.attachment.path, explicitLead);

  let resolvedCover: ArticleAttachment | undefined;
  if (coverImagePath) {
    const coverResult = await resolveArticleAttachment(coverImagePath, "coverImagePath");
    if (!coverResult.ok || !coverResult.attachment) {
      return coverResult.ok ? errorResult("VALIDATION_ERROR", "coverImagePath was not found") : coverResult.result;
    }
    resolvedCover = coverResult.attachment;
  }

  return await withEphemeralPage(page, WEIBO_ARTICLE_EDITOR_URL, async (articlePage) => {
    await openFreshWeiboArticleEditor(articlePage);
    const titleSet = await setWeiboArticleTextArea(articlePage, "标题", normalized.title);
    const leadSet = prepared.lead ? await setWeiboArticleTextArea(articlePage, "导语", prepared.lead) : true;
    const bodySet = await setWeiboArticleBody(articlePage, prepared.html);
    if (!titleSet || !leadSet || !bodySet) {
      return errorResult("UPSTREAM_CHANGED", "article editor controls not found");
    }

    if (dryRun && !publish) {
      return {
        ok: true,
        dryRun: true,
        title: normalized.title,
        ...(prepared.lead ? { lead: prepared.lead } : {}),
      };
    }

    const saved = await saveWeiboArticleDraft(articlePage);
    if (!saved) {
      return errorResult("UPSTREAM_CHANGED", "article save draft control not found");
    }

    const draftId = parseArticleDraftId(articlePage.url());
    const editUrl = articlePage.url();
    const output: Record<string, JsonValue> = {
      ok: true,
      title: normalized.title,
      editUrl,
      ...(draftId ? { draftId } : {}),
      ...(prepared.lead ? { lead: prepared.lead } : {}),
      saved: true,
    };

    if (!publish) {
      return {
        ...output,
        ...(resolvedCover ? { hasCoverImage: false } : {}),
      };
    }

    const publishReady = await advanceWeiboArticlePublishSettings(articlePage);
    if (!publishReady) {
      return errorResult("UPSTREAM_CHANGED", "article publish settings were not opened");
    }

    if (resolvedCover) {
      const uploaded = await uploadWeiboArticleCover(articlePage, resolvedCover.path);
      if (!uploaded) {
        return errorResult("UPSTREAM_CHANGED", "article cover upload failed");
      }
      output.hasCoverImage = true;
    }

    if (dryRun) {
      return {
        ...output,
        dryRun: true,
        canPublish: true,
      };
    }

    const published = await publishWeiboArticle(articlePage);
    if (!published.confirmed) {
      return errorResult("ACTION_UNCONFIRMED", "article publish was not confirmed");
    }
    return {
      ...output,
      confirmed: true,
      ...(published.url ? { url: published.url } : {}),
    };
  });
}

async function composeWeiboPost(page: Page, text: string, dryRun: boolean): Promise<WeiboComposeDomResult> {
  return await page.evaluate((input) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const composer =
      document.querySelector<HTMLTextAreaElement>("textarea[placeholder*='新鲜事']") ||
      document.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer) {
      return { ok: false, reason: "composer_not_found" } as const;
    }
    composer.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (valueSetter) {
      valueSetter.call(composer, input.text);
    } else {
      composer.value = input.text;
    }
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.text }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));

    const submit = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']")).find((element) => {
      const label = normalize(element.getAttribute("aria-label") ?? element.textContent ?? "");
      if (!label || !label.includes("发送")) {
        return false;
      }
      if (element instanceof HTMLButtonElement && element.disabled) {
        return false;
      }
      if ((element.getAttribute("aria-disabled") ?? "").toLowerCase() === "true") {
        return false;
      }
      return true;
    });
    if (!submit) {
      return { ok: false, reason: "submit_not_found" } as const;
    }
    if (input.dryRun) {
      return { ok: true, dryRun: true, submitVisible: true } as const;
    }
    submit.click();
    return { ok: true } as const;
  }, { op: "compose_post", text, dryRun });
}

async function waitForPostConfirmation(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<WeiboComposeConfirmation> {
  const deadline = Date.now() + timeoutMs;
  const needle = text.replace(/\s+/g, " ").trim().slice(0, 24);
  while (Date.now() < deadline) {
    const confirmation = await page.evaluate((input) => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>("[action-type='feed_list_item'], .Feed_wrap, [mid]"),
      );
      for (const card of cards) {
        const textNode =
          card.querySelector<HTMLElement>("[node-type='feed_list_content_full'], [node-type='feed_list_content'], .detail_wbtext_4CRf9, .wbpro-feed-content, .txt") ||
          card;
        const content = textNode.innerText.replace(/\s+/g, " ").trim();
        if (!content || !content.includes(input.needle)) {
          continue;
        }
        const url =
          card.querySelector<HTMLAnchorElement>(".from a[href], a[href*='/detail/'], a[href*='/status/']")?.href ||
          undefined;
        return { confirmed: true, ...(url ? { url } : {}) };
      }
      return { confirmed: false };
    }, { op: "confirm_post", needle }).catch(() => ({ confirmed: false }));
    if (confirmation.confirmed) {
      return confirmation;
    }
    await page.waitForTimeout(600);
  }
  return { confirmed: false };
}

async function composeWeiboComment(page: Page, text: string, dryRun: boolean): Promise<WeiboComposeDomResult> {
  return await page.evaluate((input) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const composer =
      document.querySelector<HTMLTextAreaElement>("textarea[placeholder*='评论']") ||
      document.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer) {
      return { ok: false, reason: "composer_not_found" } as const;
    }
    composer.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (valueSetter) {
      valueSetter.call(composer, input.text);
    } else {
      composer.value = input.text;
    }
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.text }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));

    const submit = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']")).find((element) => {
      const label = normalize(element.getAttribute("aria-label") ?? element.textContent ?? "");
      if (!label || !label.includes("评论")) {
        return false;
      }
      return true;
    });
    if (!submit) {
      return { ok: false, reason: "submit_not_found" } as const;
    }
    if (input.dryRun) {
      return { ok: true, dryRun: true, submitVisible: true } as const;
    }
    submit.click();
    return { ok: true } as const;
  }, { op: "compose_comment", text, dryRun });
}

async function waitForCommentConfirmation(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<WeiboComposeConfirmation> {
  const deadline = Date.now() + timeoutMs;
  const needle = text.replace(/\s+/g, " ").trim().slice(0, 24);
  while (Date.now() < deadline) {
    const confirmation = await page.evaluate((input) => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>("[id^='floor_'], .CommentItem_root, [data-testid='comment']"),
      );
      for (const item of items) {
        const content = item.innerText.replace(/\s+/g, " ").trim();
        if (content.includes(input.needle)) {
          const url = window.location.href && window.location.href.startsWith("http") ? window.location.href : undefined;
          return { confirmed: true, ...(url ? { url } : {}) };
        }
      }
      return { confirmed: false };
    }, { op: "confirm_comment", needle }).catch(() => ({ confirmed: false }));
    if (confirmation.confirmed) {
      return confirmation;
    }
    await page.waitForTimeout(600);
  }
  return { confirmed: false };
}

async function collectTimelineItems(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  targetCount: number,
): Promise<TimelineItem[]> {
  let items: TimelineItem[] = [];
  let previousCount = -1;

  for (let pass = 0; pass < MAX_HOME_SCROLL_PASSES; pass += 1) {
    items = await page.evaluate((input: { op: string; maxItems: number }) => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>("[action-type='feed_list_item'], .Feed_wrap, [mid]"),
      );
      const seen = new Set<string>();
      const output: TimelineItem[] = [];

      for (const card of cards) {
        const id =
          card.getAttribute("mid") ||
          card.dataset.mid ||
          card.dataset.id ||
          card.getAttribute("data-mid") ||
          "";
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);

        const authorLink =
          card.querySelector<HTMLAnchorElement>("a[node-type='feed_list_originNick']") ||
          card.querySelector<HTMLAnchorElement>("a.name") ||
          card.querySelector<HTMLAnchorElement>("header a[href*='/u/'], header a[href*='weibo.com/']");
        const dateLink =
          card.querySelector<HTMLAnchorElement>("a[node-type='feed_list_item_date']") ||
          card.querySelector<HTMLAnchorElement>("a[href*='/detail/']");
        const contentNode =
          card.querySelector<HTMLElement>("[node-type='feed_list_content_full']") ||
          card.querySelector<HTMLElement>("[node-type='feed_list_content']") ||
          card.querySelector<HTMLElement>(".detail_wbtext_4CRf9") ||
          card.querySelector<HTMLElement>(".wbpro-feed-content");
        const text = contentNode?.innerText?.replace(/\s+/g, " ").trim() ?? "";

        output.push({
          id,
          text,
          ...(dateLink?.href ? { url: dateLink.href } : {}),
          ...(authorLink?.textContent?.replace(/\s+/g, " ").trim()
            ? { authorName: authorLink.textContent.replace(/\s+/g, " ").trim() }
            : {}),
          ...(authorLink?.href ? { authorUrl: authorLink.href } : {}),
          ...(dateLink?.textContent?.replace(/\s+/g, " ").trim()
            ? { createdAt: dateLink.textContent.replace(/\s+/g, " ").trim() }
            : {}),
        });

        if (output.length >= input.maxItems) {
          break;
        }
      }

      return output;
    }, { op: "collect_timeline", maxItems: Math.max(targetCount, DEFAULT_TIMELINE_LIMIT) });

    if (items.length >= targetCount || items.length === previousCount) {
      break;
    }
    previousCount = items.length;
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight, 800));
    });
    await page.waitForTimeout(250);
  }

  return items;
}

async function extractCurrentPost(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
): Promise<TimelineItem | undefined> {
  return page.evaluate((input: { op: string }) => {
    const card =
      document.querySelector<HTMLElement>("[action-type='feed_list_item'], .Feed_wrap, [mid]") ||
      document.querySelector<HTMLElement>("article");
    if (!card) {
      return undefined;
    }

    const id =
      card.getAttribute("mid") ||
      card.dataset.mid ||
      card.dataset.id ||
      card.getAttribute("data-mid") ||
      "";
    if (!id) {
      return undefined;
    }

    const authorLink =
      card.querySelector<HTMLAnchorElement>("a[node-type='feed_list_originNick']") ||
      card.querySelector<HTMLAnchorElement>("a.name");
    const dateLink =
      card.querySelector<HTMLAnchorElement>("a[node-type='feed_list_item_date']") ||
      card.querySelector<HTMLAnchorElement>("a[href*='/detail/']");
    const contentNode =
      card.querySelector<HTMLElement>("[node-type='feed_list_content_full']") ||
      card.querySelector<HTMLElement>("[node-type='feed_list_content']") ||
      card.querySelector<HTMLElement>(".detail_wbtext_4CRf9") ||
      card.querySelector<HTMLElement>(".wbpro-feed-content");

    void input;
    return {
      id,
      text: contentNode?.innerText?.replace(/\s+/g, " ").trim() ?? "",
      ...(dateLink?.href ? { url: dateLink.href } : {}),
      ...(authorLink?.textContent?.replace(/\s+/g, " ").trim()
        ? { authorName: authorLink.textContent.replace(/\s+/g, " ").trim() }
        : {}),
      ...(authorLink?.href ? { authorUrl: authorLink.href } : {}),
      ...(dateLink?.textContent?.replace(/\s+/g, " ").trim()
        ? { createdAt: dateLink.textContent.replace(/\s+/g, " ").trim() }
        : {}),
    };
  }, { op: "extract_post" });
}

async function extractUserProfile(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
): Promise<UserProfile | undefined> {
  return page.evaluate((input: { op: string }) => {
    const root =
      document.querySelector<HTMLElement>(".ProfileHeader_main_1R0Xn, .woo-box-flex, .PCD_header") ||
      document.body;
    if (!root) {
      return undefined;
    }

    const nameNode =
      root.querySelector<HTMLElement>("h1, .ProfileHeader_name_1DVQQ, .pf_username") ||
      document.querySelector<HTMLElement>("h1, .ProfileHeader_name_1DVQQ, .pf_username");
    const descriptionNode =
      root.querySelector<HTMLElement>(".ProfileHeader_bio_3Pz6_ , .pf_intro, .ProfileHeader_desc_3B4mT") ||
      document.querySelector<HTMLElement>(".ProfileHeader_bio_3Pz6_, .pf_intro, .ProfileHeader_desc_3B4mT");

    const countText = (selector: string) =>
      (
        root.querySelector<HTMLElement>(selector)?.innerText ||
        document.querySelector<HTMLElement>(selector)?.innerText ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim() || undefined;

    const profileUrl =
      window.location.href && window.location.href.startsWith("http") ? window.location.href : undefined;
    const idMatch = profileUrl?.match(/weibo\.com\/u\/(\d+)/);

    const screenName = nameNode?.innerText?.replace(/\s+/g, " ").trim() || undefined;
    if (!screenName && !profileUrl) {
      return undefined;
    }

    void input;
    const followersCount = countText("a[href*='fans'] strong, a[href*='fans'] .value, .pf_fans strong");
    const followsCount = countText("a[href*='follow'] strong, a[href*='follow'] .value, .pf_follow strong");
    const description = descriptionNode?.innerText?.replace(/\s+/g, " ").trim() || undefined;

    const profile: UserProfile = {
      ...(idMatch?.[1] ? { id: idMatch[1] } : {}),
      ...(screenName ? { screenName } : {}),
      ...(profileUrl ? { profileUrl } : {}),
      ...(description ? { description } : {}),
      ...(followersCount ? { followersCount } : {}),
      ...(followsCount ? { followsCount } : {}),
    };
    return profile;
  }, { op: "extract_user" });
}

async function extractVisibleComments(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  limit: number,
): Promise<TimelineItem[]> {
  return await page.evaluate((input: { op: string; maxItems: number }) => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[id^='floor_'], .CommentItem_root, [data-testid='comment']"),
    );
    const output: TimelineItem[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      const id =
        node.getAttribute("comment_id") ||
        node.getAttribute("data-comment-id") ||
        node.id.replace(/^floor_/, "") ||
        "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const authorLink = node.querySelector<HTMLAnchorElement>("a[href*='/u/'], a[href*='/n/']");
      const textNode =
        node.querySelector<HTMLElement>(".detail_wbtext_4CRf9, .wbpro-feed-content, .text") ||
        node;
      const text = textNode.innerText.replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }
      output.push({
        id,
        text,
        ...(authorLink?.textContent?.replace(/\s+/g, " ").trim()
          ? { authorName: authorLink.textContent.replace(/\s+/g, " ").trim() }
          : {}),
        ...(authorLink?.href ? { authorUrl: authorLink.href } : {}),
      });
      if (output.length >= input.maxItems) {
        break;
      }
    }
    return output;
  }, { op: "extract_comments", maxItems: limit });
}

async function extractVisibleReposts(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  limit: number,
): Promise<TimelineItem[]> {
  return await page.evaluate((input: { op: string; maxItems: number }) => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[action-type='feed_list_item'], .Feed_wrap, [mid], .card-wrap[mid]"),
    );
    const output: TimelineItem[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      const id =
        node.getAttribute("mid") ||
        node.getAttribute("data-mid") ||
        node.dataset.mid ||
        node.dataset.id ||
        "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const authorLink =
        node.querySelector<HTMLAnchorElement>("a[node-type='feed_list_originNick'], a.name, a[href*='/u/'], a[href*='/n/']");
      const textNode =
        node.querySelector<HTMLElement>("[node-type='feed_list_content_full'], [node-type='feed_list_content'], .detail_wbtext_4CRf9, .wbpro-feed-content, .txt") ||
        node;
      const text = textNode.innerText.replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }
      output.push({
        id,
        text,
        ...(authorLink?.textContent?.replace(/\s+/g, " ").trim()
          ? { authorName: authorLink.textContent.replace(/\s+/g, " ").trim() }
          : {}),
        ...(authorLink?.href ? { authorUrl: authorLink.href } : {}),
      });
      if (output.length >= input.maxItems) {
        break;
      }
    }
    return output;
  }, { op: "extract_reposts", maxItems: limit });
}

async function extractSearchResults(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  limit: number,
): Promise<{ items: TimelineItem[]; hasMore: boolean; nextCursor?: string }> {
  const result = await page.evaluate((input: { op: string; maxItems: number }) => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".card-wrap[mid], .card-wrap"));
    const output: TimelineItem[] = [];
    const seen = new Set<string>();
    for (const card of cards) {
      const id = card.getAttribute("mid") || card.getAttribute("data-mid") || "";
      const textNode =
        card.querySelector<HTMLElement>(".txt[node-type='feed_list_content_full']") ||
        card.querySelector<HTMLElement>(".txt") ||
        card.querySelector<HTMLElement>("[node-type='feed_list_content']") ||
        card;
      const text = textNode.innerText.replace(/\s+/g, " ").trim();
      if (!id || !text || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const authorLink =
        card.querySelector<HTMLAnchorElement>(".name[href], a[href*='/u/'], a[href*='/n/']") ||
        undefined;
      const timeLink =
        card.querySelector<HTMLAnchorElement>(".from a[href]") ||
        undefined;
      output.push({
        id,
        text,
        ...(authorLink?.textContent?.replace(/\s+/g, " ").trim()
          ? { authorName: authorLink.textContent.replace(/\s+/g, " ").trim() }
          : {}),
        ...(authorLink?.href ? { authorUrl: new URL(authorLink.href, window.location.origin).toString() } : {}),
        ...(timeLink?.href ? { url: new URL(timeLink.href, window.location.origin).toString() } : {}),
        ...(timeLink?.textContent?.replace(/\s+/g, " ").trim()
          ? { createdAt: timeLink.textContent.replace(/\s+/g, " ").trim() }
          : {}),
      });
      if (output.length >= input.maxItems) {
        break;
      }
    }
    const nextLink = document.querySelector<HTMLAnchorElement>(".m-page a.next[href], a.next[href]");
    const nextHref = nextLink?.getAttribute("href") ?? undefined;
    const nextPageValue = nextHref ? new URL(nextHref, window.location.origin).searchParams.get("page") ?? undefined : undefined;
    return {
      items: output,
      hasMore: Boolean(nextPageValue),
      ...(nextPageValue ? { nextCursor: nextPageValue } : {}),
    };
  }, { op: "extract_search_results", maxItems: limit });
  if (Array.isArray(result)) {
    return {
      items: result,
      hasMore: result.length >= limit,
      ...(result.length >= limit ? { nextCursor: "2" } : {}),
    };
  }
  const typed = result as { items?: TimelineItem[]; hasMore?: boolean; nextCursor?: string } | null;
  return {
    items: Array.isArray(typed?.items) ? typed.items : [],
    hasMore: Boolean(typed?.hasMore),
    ...(typeof typed?.nextCursor === "string" && typed.nextCursor ? { nextCursor: typed.nextCursor } : {}),
  };
}

async function extractSearchResultsFromHtml(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  html: string,
  limit: number,
): Promise<{ items: TimelineItem[]; hasMore: boolean; nextCursor?: string }> {
  return await page.evaluate((input: { html: string; maxItems: number }) => {
    const doc = new DOMParser().parseFromString(input.html, "text/html");
    const cards = Array.from(doc.querySelectorAll<HTMLElement>(".card-wrap[mid], .card-wrap"));
    const output: TimelineItem[] = [];
    const seen = new Set<string>();
    for (const card of cards) {
      const id = card.getAttribute("mid") || card.getAttribute("data-mid") || "";
      const textNode =
        card.querySelector<HTMLElement>(".txt[node-type='feed_list_content_full']") ||
        card.querySelector<HTMLElement>(".txt") ||
        card.querySelector<HTMLElement>("[node-type='feed_list_content']") ||
        card;
      const text = textNode.innerText.replace(/\s+/g, " ").trim();
      if (!id || !text || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const authorLink =
        card.querySelector<HTMLAnchorElement>(".name[href], a[href*='/u/'], a[href*='/n/']") ||
        undefined;
      const timeLink =
        card.querySelector<HTMLAnchorElement>(".from a[href]") ||
        undefined;
      output.push({
        id,
        text,
        ...(authorLink?.textContent?.replace(/\s+/g, " ").trim()
          ? { authorName: authorLink.textContent.replace(/\s+/g, " ").trim() }
          : {}),
        ...(authorLink?.href ? { authorUrl: new URL(authorLink.href, "https://s.weibo.com").toString() } : {}),
        ...(timeLink?.href ? { url: new URL(timeLink.href, "https://s.weibo.com").toString() } : {}),
        ...(timeLink?.textContent?.replace(/\s+/g, " ").trim()
          ? { createdAt: timeLink.textContent.replace(/\s+/g, " ").trim() }
          : {}),
      });
      if (output.length >= input.maxItems) {
        break;
      }
    }
    const nextLink = doc.querySelector<HTMLAnchorElement>(".m-page a.next[href], a.next[href]");
    const nextHref = nextLink?.getAttribute("href") ?? undefined;
    const nextPageValue = nextHref ? new URL(nextHref, "https://s.weibo.com").searchParams.get("page") ?? undefined : undefined;
    return {
      items: output,
      hasMore: Boolean(nextPageValue),
      ...(nextPageValue ? { nextCursor: nextPageValue } : {}),
    };
  }, { html, maxItems: limit });
}

async function readSearchResultsViaRequest(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  url: string,
  limit: number,
): Promise<{ items: TimelineItem[]; hasMore: boolean; nextCursor?: string } | undefined> {
  const request = page.context().request;
  if (!request || typeof request.get !== "function") {
    return undefined;
  }
  const response = await request.get(url, { failOnStatusCode: false }).catch(() => null);
  if (!response || !response.ok()) {
    return undefined;
  }
  const html = await response.text().catch(() => "");
  if (!html.trim()) {
    return undefined;
  }
  const parsePage = await page.context().newPage();
  try {
    return await extractSearchResultsFromHtml(parsePage, html, limit);
  } finally {
    if (!parsePage.isClosed()) {
      await parsePage.close().catch(() => {});
    }
  }
}

async function extractAiSearchSummary(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  query: string,
): Promise<AiSearchSummary | undefined> {
  return await page.evaluate((input: { op: string; query: string }) => {
    const summaryNode =
      document.querySelector<HTMLElement>(".zhisou_mdtext_container, .zhisou_text_card, [data-testid='aisearch-summary']") ||
      document.querySelector<HTMLElement>(".card-wrap .txt, .card-wrap");
    const summary = summaryNode?.innerText?.replace(/\s+/g, " ").trim() || undefined;
    if (!summary) {
      return undefined;
    }
    return {
      query: input.query,
      displayQuery: input.query,
      summary,
      format: "text",
    };
  }, { op: "extract_ai_search", query });
}

async function readAiSearchSummaryViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  query: string,
): Promise<{ result?: AiSearchSummary; source: WeiboReadSource; reason?: string }> {
  const response = await page.evaluate(
    async ({ inputQuery }) => {
      const requestUrl = new URL("https://ai.s.weibo.com/api/llm/analysis_demo_result.json");
      requestUrl.searchParams.set("query", inputQuery);
      requestUrl.searchParams.set("search_source", "default_init");
      requestUrl.searchParams.set("appversion", "1.0.90");
      requestUrl.searchParams.set("sid", "pc_search");

      async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) {
          return null;
        }
        return await response.json().catch(() => null) as Record<string, unknown> | null;
      }

      let json = await fetchJson(requestUrl.toString()).catch(() => null);
      if (!json) {
        return { source: "dom" as const, reason: "request_failed" };
      }
      const hasSummary = typeof json.msg === "string" && json.msg.trim().length > 0;
      if (!hasSummary) {
        requestUrl.searchParams.set("content_type", "loop");
        requestUrl.searchParams.set("request_id", "webmcp");
        requestUrl.searchParams.set("request_time", "webmcp");
        requestUrl.searchParams.set("cot", "2");
        requestUrl.searchParams.set("loop_num", "1");
        json = await fetchJson(requestUrl.toString()).catch(() => null);
        if (!json) {
          return { source: "dom" as const, reason: "request_failed" };
        }
      }
      const summary =
        typeof json.msg === "string" && json.msg.trim()
          ? json.msg.trim()
          : undefined;

      const midList = Array.isArray(json.mid_list)
        ? json.mid_list.flatMap((value) => {
            if (typeof value === "string" && value.trim()) {
              return [value.trim()];
            }
            if (typeof value === "number") {
              return [String(value)];
            }
            return [];
          })
        : [];

      return {
        source: "network" as const,
        result: {
          query: inputQuery,
          ...(typeof json.display_query === "string" && json.display_query.trim()
            ? { displayQuery: json.display_query.trim() }
            : {}),
          ...(summary ? { summary } : {}),
          ...(typeof json.msg_format === "string" && json.msg_format.trim() ? { format: json.msg_format.trim() } : {}),
          ...(typeof json.status === "number" ? { status: json.status } : {}),
          ...(typeof json.qs_status === "number" ? { qsStatus: json.qs_status } : {}),
          ...(typeof json.status_stage === "number" ? { statusStage: json.status_stage } : {}),
          ...(typeof json.reference_num === "number" ? { referenceCount: json.reference_num } : {}),
          ...(midList.length > 0 ? { relatedPostIds: midList } : {}),
        },
        ...(summary ? {} : { reason: "summary_unavailable" as const }),
      };
    },
    { inputQuery: query },
  );

  const typed = response as { result?: AiSearchSummary; source?: "network" | "dom"; reason?: string } | null;
  if (!typed || typeof typed !== "object") {
    return {
      source: "dom",
      reason: "invalid_response",
    };
  }
  return {
    ...(typed.result ? { result: typed.result } : {}),
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

function normalizeTimelineItem(raw: Record<string, unknown>): TimelineItem | undefined {
  const id = extractWeiboPostId(raw);
  const text = extractWeiboPostText(raw);
  if (!id || !text) {
    return undefined;
  }

  const user = raw.user && typeof raw.user === "object" && !Array.isArray(raw.user)
    ? (raw.user as Record<string, unknown>)
    : undefined;
  const screenName = typeof user?.screen_name === "string" ? user.screen_name : undefined;
  const authorUrl = typeof user?.profile_url === "string" && user.profile_url
    ? new URL(String(user.profile_url), "https://weibo.com").toString()
    : undefined;
  const item: TimelineItem = {
    id,
    text,
    ...(screenName ? { authorName: screenName } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(typeof raw.created_at === "string" ? { createdAt: raw.created_at } : {}),
    ...(screenName ? { url: `https://weibo.com/${screenName}/${id}` } : {}),
  };
  return item;
}

function extractWeiboPostId(raw: Record<string, unknown>): string {
  return typeof raw.idstr === "string"
    ? raw.idstr
    : typeof raw.mid === "string"
      ? raw.mid
      : typeof raw.id === "number"
        ? String(raw.id)
        : typeof raw.id === "string"
          ? raw.id
          : "";
}

function extractWeiboPostText(raw: Record<string, unknown>): string {
  const longText = typeof raw.longTextContent_raw === "string"
    ? raw.longTextContent_raw
    : typeof raw.longTextContent === "string"
      ? raw.longTextContent
      : typeof raw.text_raw === "string"
        ? raw.text_raw
        : typeof raw.text === "string"
          ? raw.text
          : "";
  return longText.trim();
}

function needsLongTextHydration(raw: Record<string, unknown>): boolean {
  const isLongText = raw.isLongText === true || raw.isLongText === 1 || raw.isLongText === "true";
  if (!isLongText) {
    return false;
  }
  return typeof raw.longTextContent_raw !== "string" && typeof raw.longTextContent !== "string";
}

async function hydrateLongTextItems(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  items: unknown[],
): Promise<Array<Record<string, unknown>>> {
  const rawItems = items.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    return [entry as Record<string, unknown>];
  });
  const pendingIds = rawItems
    .map((entry) => ({ id: extractWeiboPostId(entry), needsHydration: needsLongTextHydration(entry) }))
    .filter((entry) => entry.id && entry.needsHydration)
    .map((entry) => entry.id);
  if (!pendingIds.length) {
    return rawItems;
  }

  const detailed = await page.evaluate(async ({ ids }) => {
    const result: Record<string, Record<string, unknown>> = {};
    for (const id of ids) {
      try {
        const requestUrl = new URL("/ajax/statuses/show", location.origin);
        requestUrl.searchParams.set("id", id);
        requestUrl.searchParams.set("isGetLongText", "true");
        requestUrl.searchParams.set("locale", "en-US");
        const response = await fetch(requestUrl.toString(), {
          credentials: "include",
        });
        if (!response.ok) {
          continue;
        }
        const json = await response.json().catch(() => null);
        if (json && typeof json === "object" && !Array.isArray(json)) {
          result[id] = json as Record<string, unknown>;
        }
      } catch {
        continue;
      }
    }
    return result;
  }, { ids: pendingIds });

  const detailMap = detailed && typeof detailed === "object" && !Array.isArray(detailed)
    ? detailed as Record<string, Record<string, unknown>>
    : {};
  return rawItems.map((entry) => {
    const id = extractWeiboPostId(entry);
    const detail = id ? detailMap[id] : undefined;
    return detail ? { ...entry, ...detail } : entry;
  });
}

function normalizeUserProfile(raw: Record<string, unknown>): UserProfile | undefined {
  const userRecord =
    raw.user && typeof raw.user === "object" && !Array.isArray(raw.user)
      ? (raw.user as Record<string, unknown>)
      : raw;
  const id =
    typeof userRecord.idstr === "string"
      ? userRecord.idstr
      : typeof userRecord.id === "number"
        ? String(userRecord.id)
        : typeof userRecord.id === "string"
          ? userRecord.id
          : undefined;
  const screenName = typeof userRecord.screen_name === "string" ? userRecord.screen_name.trim() : undefined;
  if (!id && !screenName) {
    return undefined;
  }
  const profileUrl = id ? `https://weibo.com/u/${id}` : undefined;
  const profile: UserProfile = {
    ...(id ? { id } : {}),
    ...(screenName ? { screenName } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(typeof userRecord.description === "string" && userRecord.description.trim()
      ? { description: userRecord.description.trim() }
      : {}),
    ...(typeof userRecord.followers_count_str === "string" && userRecord.followers_count_str.trim()
      ? { followersCount: userRecord.followers_count_str.trim() }
      : typeof userRecord.followers_count === "number"
        ? { followersCount: String(userRecord.followers_count) }
        : {}),
    ...(typeof userRecord.friends_count === "number"
      ? { followsCount: String(userRecord.friends_count) }
      : {}),
  };
  return profile;
}

async function readTimelineViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  limit: number,
  cursor?: string,
): Promise<{ items: TimelineItem[]; nextCursor?: string; source: WeiboReadSource; reason?: string }> {
  const cachedTemplate = PROCESS_TEMPLATE_CACHE.get("timeline.home.list");
  const response = await page.evaluate(
    async ({ inputLimit, inputCursor, fallbackTemplate, headerAllowlist }) => {
      const globalAny = window as unknown as {
        __WEBMCP_WEIBO_CAPTURE__?: {
          entries?: Array<{
            op?: string;
            url?: string;
            method?: string;
            headers?: Record<string, string>;
            body?: string;
          }>;
        };
      };
      const entries = Array.isArray(globalAny.__WEBMCP_WEIBO_CAPTURE__?.entries)
        ? globalAny.__WEBMCP_WEIBO_CAPTURE__.entries
        : [];
      const selected = entries
        .slice()
        .reverse()
        .find((entry) => entry?.op === "timeline.home.list" && typeof entry.url === "string" && typeof entry.method === "string")
        ?? fallbackTemplate
        ?? null;
      if (!selected || typeof selected.url !== "string" || typeof selected.method !== "string") {
        return { source: "dom" as const, reason: "no_template", items: [] };
      }
      const requestUrl = new URL(selected.url, location.origin);
      const templateListId = requestUrl.searchParams.get("list_id");
      if (!requestUrl.searchParams.get("list_id") && templateListId) {
        requestUrl.searchParams.set("list_id", templateListId);
      }
      if (typeof inputCursor === "string" && inputCursor) {
        requestUrl.searchParams.set("refresh", "0");
        requestUrl.searchParams.set("max_id", inputCursor);
        requestUrl.searchParams.delete("since_id");
      } else {
        if (!requestUrl.searchParams.get("refresh")) {
          requestUrl.searchParams.set("refresh", "4");
        }
        if (!requestUrl.searchParams.get("since_id")) {
          requestUrl.searchParams.set("since_id", "0");
        }
      }
      requestUrl.searchParams.set("count", String(inputLimit));
      const headers = Object.entries(selected.headers ?? {}).reduce<Record<string, string>>((result, [key, value]) => {
        if (typeof value === "string" && headerAllowlist.some((allowed) => allowed === key.toLowerCase())) {
          result[key] = value;
        }
        return result;
      }, {});
      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
          credentials: "include",
        });
      } catch {
        return { source: "dom" as const, reason: "request_failed", items: [] };
      }
      if (!response.ok) {
        return { source: "dom" as const, reason: `http_error_${response.status}`, items: [] };
      }
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      const statuses = Array.isArray(json?.statuses) ? json.statuses : [];
      const nextCursor =
        typeof json?.since_id_str === "string"
          ? json.since_id_str
          : typeof json?.since_id === "string"
            ? json.since_id
            : typeof json?.max_id_str === "string"
              ? json.max_id_str
              : undefined;
      return {
        source: "network" as const,
        items: statuses,
        nextCursor,
        selectedTemplate: {
          url: requestUrl.toString(),
          method: selected.method,
          headers,
        },
      };
    },
    {
      inputLimit: limit,
      inputCursor: cursor,
      fallbackTemplate: cachedTemplate,
      headerAllowlist: [...TEMPLATE_HEADER_ALLOWLIST],
    },
  );

  const typed = response as {
    items?: unknown[];
    nextCursor?: string;
    source?: "network" | "dom";
    reason?: string;
    selectedTemplate?: RequestTemplate;
  };
  if (!typed || typeof typed !== "object") {
    return {
      items: [],
      source: "dom",
      reason: "invalid_response",
    };
  }
  if (typed.selectedTemplate?.url && typed.selectedTemplate.method) {
    PROCESS_TEMPLATE_CACHE.set("timeline.home.list", typed.selectedTemplate);
  }
  const hydratedItems = Array.isArray(typed.items) ? await hydrateLongTextItems(page, typed.items) : [];
  const items = hydratedItems
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const item = normalizeTimelineItem(entry as Record<string, unknown>);
      return item ? [item] : [];
    });
  return {
    items,
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.nextCursor ? { nextCursor: typed.nextCursor } : {}),
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

async function readPostViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  id: string,
): Promise<{ post?: TimelineItem; source: WeiboReadSource; reason?: string }> {
  const cachedTemplate = PROCESS_TEMPLATE_CACHE.get("post.get");
  const response = await page.evaluate(
    async ({ inputId, fallbackTemplate, headerAllowlist }) => {
      const globalAny = window as unknown as {
        __WEBMCP_WEIBO_CAPTURE__?: { entries?: Array<{ op?: string; url?: string; method?: string; headers?: Record<string, string> }> };
      };
      const entries = Array.isArray(globalAny.__WEBMCP_WEIBO_CAPTURE__?.entries) ? globalAny.__WEBMCP_WEIBO_CAPTURE__.entries : [];
      const selected = entries
        .slice()
        .reverse()
        .find((entry) => entry?.op === "post.get" && typeof entry.url === "string" && typeof entry.method === "string")
        ?? fallbackTemplate
        ?? {
          url: "/ajax/statuses/show?id=0",
          method: "GET",
          headers: {},
        };
      const requestUrl = new URL(String(selected.url), location.origin);
      requestUrl.pathname = "/ajax/statuses/show";
      requestUrl.search = "";
      requestUrl.searchParams.set("id", inputId);
      requestUrl.searchParams.set("isGetLongText", "true");
      requestUrl.searchParams.set("locale", "en-US");
      const headers = Object.entries(selected.headers ?? {}).reduce<Record<string, string>>((result, [key, value]) => {
        if (typeof value === "string" && headerAllowlist.some((allowed) => allowed === key.toLowerCase())) {
          result[key] = value;
        }
        return result;
      }, {});
      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
          credentials: "include",
        });
      } catch {
        return { source: "dom" as const, reason: "request_failed" };
      }
      if (!response.ok) {
        return { source: "dom" as const, reason: `http_error_${response.status}` };
      }
      const json = await response.json().catch(() => null);
      return {
        source: "network" as const,
        post: json,
        selectedTemplate: {
          url: requestUrl.toString(),
          method: selected.method,
          headers,
        },
      };
    },
    { inputId: id, fallbackTemplate: cachedTemplate, headerAllowlist: [...TEMPLATE_HEADER_ALLOWLIST] },
  );
  const typed = response as { post?: unknown; source?: "network" | "dom"; reason?: string; selectedTemplate?: RequestTemplate };
  if (!typed || typeof typed !== "object") {
    return {
      source: "dom",
      reason: "invalid_response",
    };
  }
  if (typed.selectedTemplate?.url && typed.selectedTemplate.method) {
    PROCESS_TEMPLATE_CACHE.set("post.get", typed.selectedTemplate);
  }
  const post =
    typed.post && typeof typed.post === "object" && !Array.isArray(typed.post)
      ? normalizeTimelineItem(typed.post as Record<string, unknown>)
      : undefined;
  return {
    ...(post ? { post } : {}),
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

async function readPostRepliesViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  id: string,
  cursor?: string,
): Promise<{ items: TimelineItem[]; nextCursor?: string; source: "network" | "dom"; reason?: string }> {
  const cachedTemplate = PROCESS_TEMPLATE_CACHE.get("post.replies.list");
  const response = await page.evaluate(
    async ({ inputId, inputCursor, fallbackTemplate, headerAllowlist }) => {
      const globalAny = window as unknown as {
        __WEBMCP_WEIBO_CAPTURE__?: { entries?: Array<{ op?: string; url?: string; method?: string; headers?: Record<string, string> }> };
      };
      const entries = Array.isArray(globalAny.__WEBMCP_WEIBO_CAPTURE__?.entries) ? globalAny.__WEBMCP_WEIBO_CAPTURE__.entries : [];
      const selected = entries
        .slice()
        .reverse()
        .find((entry) => entry?.op === "post.replies.list" && typeof entry.url === "string" && typeof entry.method === "string")
        ?? fallbackTemplate
        ?? {
          url: "/ajax/statuses/buildComments?is_reload=1&id=0&is_show_bulletin=2&is_mix=0&count=10&fetch_level=0",
          method: "GET",
          headers: {},
        };
      const showUrl = new URL("/ajax/statuses/show", location.origin);
      showUrl.searchParams.set("id", inputId);
      showUrl.searchParams.set("locale", "en-US");
      showUrl.searchParams.set("isGetLongText", "true");
      let showResponse: Response;
      try {
        showResponse = await fetch(showUrl.toString(), { credentials: "include" });
      } catch {
        return { source: "dom" as const, reason: "request_failed", items: [] };
      }
      const showJson = await showResponse.json().catch(() => null) as Record<string, unknown> | null;
      const authorUid = String(
        ((showJson?.user && typeof showJson.user === "object" && !Array.isArray(showJson.user)
          ? (showJson.user as Record<string, unknown>).idstr ?? (showJson.user as Record<string, unknown>).id
          : undefined) ?? ""),
      );
      if (!authorUid) {
        return { source: "dom" as const, reason: "author_uid_missing", items: [] };
      }

      const requestUrl = new URL(String(selected.url), location.origin);
      requestUrl.pathname = "/ajax/statuses/buildComments";
      requestUrl.search = "";
      requestUrl.searchParams.set("is_reload", "1");
      requestUrl.searchParams.set("id", inputId);
      requestUrl.searchParams.set("is_show_bulletin", "2");
      requestUrl.searchParams.set("is_mix", "0");
      requestUrl.searchParams.set("count", "10");
      requestUrl.searchParams.set("uid", authorUid);
      requestUrl.searchParams.set("fetch_level", "0");
      requestUrl.searchParams.set("locale", "en-US");
      if (typeof inputCursor === "string" && inputCursor.trim()) {
        requestUrl.searchParams.set("max_id", inputCursor.trim());
      }

      const headers = Object.entries(selected.headers ?? {}).reduce<Record<string, string>>((result, [key, value]) => {
        if (typeof value === "string" && headerAllowlist.some((allowed) => allowed === key.toLowerCase())) {
          result[key] = value;
        }
        return result;
      }, {});
      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
          credentials: "include",
        });
      } catch {
        return { source: "dom" as const, reason: "request_failed", items: [] };
      }
      if (!response.ok) {
        return { source: "dom" as const, reason: `http_error_${response.status}`, items: [] };
      }
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      const list = Array.isArray(json?.data) ? json.data : [];
      const maxId =
        typeof json?.max_id === "number"
          ? String(json.max_id)
          : typeof json?.max_id === "string"
            ? json.max_id
            : undefined;
      return {
        source: "network" as const,
        items: list,
        nextCursor: maxId && maxId !== "0" ? maxId : undefined,
        selectedTemplate: {
          url: requestUrl.toString(),
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
        },
      };
    },
    { inputId: id, inputCursor: cursor, fallbackTemplate: cachedTemplate, headerAllowlist: [...TEMPLATE_HEADER_ALLOWLIST] },
  );
  const typed = response as { items?: unknown[]; nextCursor?: string; source?: "network" | "dom"; reason?: string; selectedTemplate?: RequestTemplate };
  if (!typed || typeof typed !== "object") {
    return {
      items: [],
      source: "dom",
      reason: "invalid_response",
    };
  }
  if (typed.selectedTemplate?.url && typed.selectedTemplate.method) {
    PROCESS_TEMPLATE_CACHE.set("post.replies.list", typed.selectedTemplate);
  }
  const hydratedItems = Array.isArray(typed.items) ? await hydrateLongTextItems(page, typed.items) : [];
  const items = hydratedItems
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const raw = entry as Record<string, unknown>;
      const user = raw.user && typeof raw.user === "object" && !Array.isArray(raw.user)
        ? (raw.user as Record<string, unknown>)
        : undefined;
      const id =
        typeof raw.idstr === "string"
          ? raw.idstr
          : typeof raw.id === "number"
            ? String(raw.id)
            : typeof raw.id === "string"
              ? raw.id
              : "";
      const text = extractWeiboPostText(raw);
      if (!id || !text) {
        return [];
      }
      const authorName = typeof user?.screen_name === "string" ? user.screen_name : undefined;
      const authorUrl = typeof user?.profile_url === "string" ? new URL(user.profile_url, "https://weibo.com").toString() : undefined;
      return [{
        id,
        text,
        ...(authorName ? { authorName } : {}),
        ...(authorUrl ? { authorUrl } : {}),
        ...(typeof raw.created_at === "string" ? { createdAt: raw.created_at } : {}),
      }];
    });
  return {
    items,
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.nextCursor ? { nextCursor: typed.nextCursor } : {}),
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

async function readPostRepostsViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  id: string,
  cursor?: string,
): Promise<{ items: TimelineItem[]; nextCursor?: string; source: "network" | "dom"; reason?: string }> {
  const cachedTemplate = PROCESS_TEMPLATE_CACHE.get("post.repost.list");
  const response = await page.evaluate(
    async ({ inputId, inputCursor, fallbackTemplate, headerAllowlist }) => {
      const globalAny = window as unknown as {
        __WEBMCP_WEIBO_CAPTURE__?: { entries?: Array<{ op?: string; url?: string; method?: string; headers?: Record<string, string> }> };
      };
      const entries = Array.isArray(globalAny.__WEBMCP_WEIBO_CAPTURE__?.entries) ? globalAny.__WEBMCP_WEIBO_CAPTURE__.entries : [];
      const selected = entries
        .slice()
        .reverse()
        .find((entry) => entry?.op === "post.repost.list" && typeof entry.url === "string" && typeof entry.method === "string")
        ?? fallbackTemplate
        ?? {
          url: "/ajax/statuses/repostTimeline?id=0&page=1",
          method: "GET",
          headers: {},
        };
      const requestUrl = new URL(String(selected.url), location.origin);
      requestUrl.pathname = "/ajax/statuses/repostTimeline";
      requestUrl.search = "";
      requestUrl.searchParams.set("id", inputId);
      const currentPage = typeof inputCursor === "string" && inputCursor.trim() ? Number.parseInt(inputCursor.trim(), 10) : 1;
      if (Number.isInteger(currentPage) && currentPage > 0) {
        requestUrl.searchParams.set("page", String(currentPage));
      } else {
        requestUrl.searchParams.set("page", "1");
      }
      const headers = Object.entries(selected.headers ?? {}).reduce<Record<string, string>>((result, [key, value]) => {
        if (typeof value === "string" && headerAllowlist.some((allowed) => allowed === key.toLowerCase())) {
          result[key] = value;
        }
        return result;
      }, {});
      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
          credentials: "include",
        });
      } catch {
        return { source: "dom" as const, reason: "request_failed", items: [] };
      }
      if (!response.ok) {
        return { source: "dom" as const, reason: `http_error_${response.status}`, items: [] };
      }
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      const list = Array.isArray(json?.data) ? json.data : [];
      const maxPage =
        typeof json?.max_page === "number"
          ? json.max_page
          : typeof json?.max_page === "string"
            ? Number.parseInt(json.max_page, 10)
            : undefined;
      return {
        source: "network" as const,
        items: list,
        nextCursor: list.length > 0 && Number.isInteger(currentPage) && (maxPage === undefined || currentPage < maxPage)
          ? String(currentPage + 1)
          : undefined,
        selectedTemplate: {
          url: requestUrl.toString(),
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
        },
      };
    },
    { inputId: id, inputCursor: cursor, fallbackTemplate: cachedTemplate, headerAllowlist: [...TEMPLATE_HEADER_ALLOWLIST] },
  );
  const typed = response as { items?: unknown[]; nextCursor?: string; source?: "network" | "dom"; reason?: string; selectedTemplate?: RequestTemplate };
  if (!typed || typeof typed !== "object") {
    return {
      items: [],
      source: "dom",
      reason: "invalid_response",
    };
  }
  if (typed.selectedTemplate?.url && typed.selectedTemplate.method) {
    PROCESS_TEMPLATE_CACHE.set("post.repost.list", typed.selectedTemplate);
  }
  const hydratedItems = Array.isArray(typed.items) ? await hydrateLongTextItems(page, typed.items) : [];
  const items = hydratedItems
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const item = normalizeTimelineItem(entry as Record<string, unknown>);
      return item ? [item] : [];
    });
  return {
    items,
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.nextCursor ? { nextCursor: typed.nextCursor } : {}),
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

async function readUserViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  uid: string,
): Promise<{ user?: UserProfile; source: "network" | "dom"; reason?: string }> {
  const cachedTemplate = PROCESS_TEMPLATE_CACHE.get("user.get");
  const response = await page.evaluate(
    async ({ inputUid, fallbackTemplate, headerAllowlist }) => {
      const globalAny = window as unknown as {
        __WEBMCP_WEIBO_CAPTURE__?: { entries?: Array<{ op?: string; url?: string; method?: string; headers?: Record<string, string> }> };
      };
      const entries = Array.isArray(globalAny.__WEBMCP_WEIBO_CAPTURE__?.entries) ? globalAny.__WEBMCP_WEIBO_CAPTURE__.entries : [];
      const selected = entries
        .slice()
        .reverse()
        .find((entry) => entry?.op === "user.get" && typeof entry.url === "string" && typeof entry.method === "string")
        ?? fallbackTemplate
        ?? {
          url: "/ajax/profile/info?uid=0",
          method: "GET",
          headers: {},
        };
      const requestUrl = new URL(String(selected.url), location.origin);
      requestUrl.pathname = "/ajax/profile/info";
      requestUrl.search = "";
      requestUrl.searchParams.set("uid", inputUid);
      const headers = Object.entries(selected.headers ?? {}).reduce<Record<string, string>>((result, [key, value]) => {
        if (typeof value === "string" && headerAllowlist.some((allowed) => allowed === key.toLowerCase())) {
          result[key] = value;
        }
        return result;
      }, {});
      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
          credentials: "include",
        });
      } catch {
        return { source: "dom" as const, reason: "request_failed" };
      }
      if (!response.ok) {
        return { source: "dom" as const, reason: `http_error_${response.status}` };
      }
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      const payload =
        json?.data && typeof json.data === "object" && !Array.isArray(json.data)
          ? (json.data as Record<string, unknown>)
          : json;
      return {
        source: "network" as const,
        user: payload,
        selectedTemplate: {
          url: requestUrl.toString(),
          method: selected.method,
          headers,
        },
      };
    },
    { inputUid: uid, fallbackTemplate: cachedTemplate, headerAllowlist: [...TEMPLATE_HEADER_ALLOWLIST] },
  );
  const typed = response as { user?: unknown; source?: "network" | "dom"; reason?: string; selectedTemplate?: RequestTemplate };
  if (!typed || typeof typed !== "object") {
    return {
      source: "dom",
      reason: "invalid_response",
    };
  }
  if (typed.selectedTemplate?.url && typed.selectedTemplate.method) {
    PROCESS_TEMPLATE_CACHE.set("user.get", typed.selectedTemplate);
  }
  const user =
    typed.user && typeof typed.user === "object" && !Array.isArray(typed.user)
      ? normalizeUserProfile(typed.user as Record<string, unknown>)
      : undefined;
  return {
    ...(user ? { user } : {}),
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

async function readUserPostsViaNetwork(
  page: Parameters<SiteAdapter["callTool"]>[1]["page"],
  uid: string,
  cursor?: string,
): Promise<{ items: TimelineItem[]; nextCursor?: string; source: "network" | "dom"; reason?: string }> {
  const cachedTemplate = PROCESS_TEMPLATE_CACHE.get("user.posts.list");
  const response = await page.evaluate(
    async ({ inputUid, inputCursor, fallbackTemplate, headerAllowlist }) => {
      const globalAny = window as unknown as {
        __WEBMCP_WEIBO_CAPTURE__?: { entries?: Array<{ op?: string; url?: string; method?: string; headers?: Record<string, string> }> };
      };
      const entries = Array.isArray(globalAny.__WEBMCP_WEIBO_CAPTURE__?.entries) ? globalAny.__WEBMCP_WEIBO_CAPTURE__.entries : [];
      const selected = entries
        .slice()
        .reverse()
        .find((entry) => entry?.op === "user.posts.list" && typeof entry.url === "string" && typeof entry.method === "string")
        ?? fallbackTemplate
        ?? {
          url: "/ajax/statuses/mymblog?uid=0&page=1&feature=0",
          method: "GET",
          headers: {},
        };
      const requestUrl = new URL(String(selected.url), location.origin);
      requestUrl.pathname = "/ajax/statuses/mymblog";
      requestUrl.search = "";
      requestUrl.searchParams.set("uid", inputUid);
      requestUrl.searchParams.set("feature", "0");
      requestUrl.searchParams.set("page", typeof inputCursor === "string" && inputCursor.trim() ? inputCursor.trim() : "1");
      const headers = Object.entries(selected.headers ?? {}).reduce<Record<string, string>>((result, [key, value]) => {
        if (typeof value === "string" && headerAllowlist.some((allowed) => allowed === key.toLowerCase())) {
          result[key] = value;
        }
        return result;
      }, {});
      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
          credentials: "include",
        });
      } catch {
        return { source: "dom" as const, reason: "request_failed", items: [] };
      }
      if (!response.ok) {
        return { source: "dom" as const, reason: `http_error_${response.status}`, items: [] };
      }
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      const data =
        json?.data && typeof json.data === "object" && !Array.isArray(json.data)
          ? (json.data as Record<string, unknown>)
          : undefined;
      const list = Array.isArray(data?.list) ? data.list : [];
      const currentPage = Number.parseInt(requestUrl.searchParams.get("page") ?? "1", 10);
      return {
        source: "network" as const,
        items: list,
        nextCursor: list.length > 0 && Number.isInteger(currentPage) ? String(currentPage + 1) : undefined,
        selectedTemplate: {
          url: requestUrl.toString(),
          method: typeof selected.method === "string" && selected.method ? selected.method : "GET",
          headers,
        },
      };
    },
    { inputUid: uid, inputCursor: cursor, fallbackTemplate: cachedTemplate, headerAllowlist: [...TEMPLATE_HEADER_ALLOWLIST] },
  );
  const typed = response as { items?: unknown[]; nextCursor?: string; source?: "network" | "dom"; reason?: string; selectedTemplate?: RequestTemplate };
  if (!typed || typeof typed !== "object") {
    return {
      items: [],
      source: "dom",
      reason: "invalid_response",
    };
  }
  if (typed.selectedTemplate?.url && typed.selectedTemplate.method) {
    PROCESS_TEMPLATE_CACHE.set("user.posts.list", typed.selectedTemplate);
  }
  const hydratedItems = Array.isArray(typed.items) ? await hydrateLongTextItems(page, typed.items) : [];
  const items = hydratedItems
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const item = normalizeTimelineItem(entry as Record<string, unknown>);
      return item ? [item] : [];
    });
  return {
    items,
    source: typed.source === "network" ? "network" : "dom",
    ...(typed.nextCursor ? { nextCursor: typed.nextCursor } : {}),
    ...(typed.reason ? { reason: typed.reason } : {}),
  };
}

export function createWeiboAdapter(): SiteAdapter {
  return {
    name: "adapter-weibo",
    start: async ({ page }) => {
      await ensureCaptureInstalled(page);
    },
    stop: async ({ page }) => {
      await closeCachedReadPages(page);
    },
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }, { page }) => {
      const args = toRecord(input);
      await ensureCaptureInstalled(page);

      if (name === "auth.get") {
        const auth = await detectAuthState(page);
        return {
          ...auth,
          source: "adapter-weibo",
        };
      }

      if (name === "page.get") {
        return {
          url: page.url(),
          title: await page.title(),
          source: "adapter-weibo",
        };
      }

      if (name === "timeline.home.list") {
        const limit = readLimit(args) ?? DEFAULT_TIMELINE_LIMIT;
        const cursor = readNonEmptyString(args, "cursor");
        const parsedCursor = parseCursor(cursor);
        if (cursor !== undefined && parsedCursor === undefined) {
          return errorResult("VALIDATION_ERROR", "cursor must be a previous nextCursor value or dom:<offset>");
        }

        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }

        const networkCursor = parsedCursor?.kind === "network" ? parsedCursor.value : undefined;
        let networkResult = await readTimelineViaNetwork(page, limit, networkCursor);
        if (networkResult.source !== "network" && parsedCursor?.kind !== "dom") {
          networkResult = await withCachedReadPage(page, HOME_TIMELINE_URL, async (readPage) => {
            await readPage.waitForTimeout(800);
            return await readTimelineViaNetwork(readPage, limit, networkCursor);
          });
        }
        if (networkResult.source === "network" && networkResult.items.length > 0) {
          return {
            items: networkResult.items.slice(0, limit),
            hasMore: Boolean(networkResult.nextCursor),
            source: "network",
            ...(networkResult.nextCursor ? { nextCursor: networkResult.nextCursor } : {}),
            ...(networkResult.reason ? { reason: networkResult.reason } : {}),
          };
        }

        const offset = parsedCursor?.kind === "dom" ? parsedCursor.offset : 0;
        const allItems = await collectTimelineItems(page, offset + limit + 1);
        const slice = allItems.slice(offset, offset + limit);
        const hasMore = allItems.length > offset + limit;

        return {
          items: slice,
          hasMore,
          source: "dom",
          ...(hasMore ? { nextCursor: `${LEGACY_DOM_CURSOR_PREFIX}${offset + limit}` } : {}),
          ...(networkResult.source === "dom" && networkResult.reason && networkResult.reason !== "invalid_response"
            ? { reason: networkResult.reason }
            : {}),
        };
      }

      if (name === "post.create") {
        const text = readNonEmptyString(args, "text");
        if (!text) {
          return errorResult("VALIDATION_ERROR", "text is required");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        return await withEphemeralPage(page, HOME_TIMELINE_URL, async (writePage) => {
          await waitForWeiboSurface(writePage);
          const composeResult = await composeWeiboPost(writePage, text, args.dryRun === true);
          if (!composeResult.ok) {
            return errorResult("UPSTREAM_CHANGED", "post compose controls not found");
          }
          if (composeResult.dryRun) {
            return {
              ok: true,
              dryRun: true,
              submitVisible: composeResult.submitVisible === true,
            };
          }
          const confirmation = await waitForPostConfirmation(writePage, text, DEFAULT_WRITE_CONFIRM_TIMEOUT_MS);
          if (!confirmation.confirmed) {
            return errorResult("ACTION_UNCONFIRMED", "post submit was not confirmed in timeline");
          }
          return {
            ok: true,
            confirmed: true,
            ...(confirmation.url ? { url: confirmation.url } : {}),
          };
        });
      }

      if (name === "post.get") {
        const url = readNonEmptyString(args, "url");
        const id = readNonEmptyString(args, "id");
        if (!url && !id) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const targetUrl = url ?? buildPostUrl(id as string);
        if (!isAllowedWeiboUrl(targetUrl)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within weibo.com hosts");
        }

        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }

        const targetId = id ?? targetUrl.match(/(\d{8,})/)?.[1];
        if (targetId) {
          const networkResult = await readPostViaNetwork(page, targetId);
          if (networkResult.post) {
            return {
              post: networkResult.post,
              source: networkResult.source,
              ...(networkResult.reason ? { reason: networkResult.reason } : {}),
            };
          }
        }

        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
        const post = await extractCurrentPost(page);
        if (!post) {
          return errorResult("UPSTREAM_CHANGED", "unable to locate the target Weibo post");
        }
        return {
          post,
          source: "dom",
        };
      }

      if (name === "comment.create") {
        const text = readNonEmptyString(args, "text");
        const url = readNonEmptyString(args, "url");
        const id = readNonEmptyString(args, "id");
        if (!text) {
          return errorResult("VALIDATION_ERROR", "text is required");
        }
        if (!url && !id) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const targetUrl = url ?? buildPostUrl(id as string);
        if (!isAllowedWeiboUrl(targetUrl)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within weibo.com hosts");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        return await withEphemeralPage(page, targetUrl, async (commentPage) => {
          await waitForWeiboSurface(commentPage);
          const composeResult = await composeWeiboComment(commentPage, text, args.dryRun === true);
          if (!composeResult.ok) {
            return errorResult("UPSTREAM_CHANGED", "comment controls not found");
          }
          if (composeResult.dryRun) {
            return {
              ok: true,
              dryRun: true,
              submitVisible: composeResult.submitVisible === true,
              commentToUrl: targetUrl,
            };
          }
          const confirmation = await waitForCommentConfirmation(commentPage, text, DEFAULT_WRITE_CONFIRM_TIMEOUT_MS);
          if (!confirmation.confirmed) {
            return errorResult("ACTION_UNCONFIRMED", "comment submit was not confirmed in replies");
          }
          return {
            ok: true,
            confirmed: true,
            commentToUrl: targetUrl,
            ...(confirmation.url ? { url: confirmation.url } : {}),
          };
        });
      }

      if (name === "article.listDrafts") {
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        return await withEphemeralPage(page, WEIBO_ARTICLE_EDITOR_URL, async (articlePage) => {
          await waitForWeiboArticleEditor(articlePage);
          const drafts = await extractWeiboArticleDrafts(articlePage);
          return {
            items: drafts,
            source: "dom",
          };
        });
      }

      if (name === "article.getDraft") {
        const draftId = readNonEmptyString(args, "draftId");
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        return await withEphemeralPage(page, buildArticleEditUrl(draftId), async (articlePage) => {
          await waitForWeiboArticleEditor(articlePage);
          const draft = await extractWeiboArticleDraft(articlePage);
          if (!draft) {
            return errorResult("UPSTREAM_CHANGED", "article draft editor content not found");
          }
          return {
            draft,
            source: "dom",
          };
        });
      }

      if (name === "article.draftMarkdown") {
        const markdownPath = readNonEmptyString(args, "markdownPath");
        if (!markdownPath) {
          return errorResult("VALIDATION_ERROR", "markdownPath is required");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        return await createWeiboArticleFromMarkdown(
          page,
          markdownPath,
          readNonEmptyString(args, "title"),
          readNonEmptyString(args, "lead"),
          readNonEmptyString(args, "coverImagePath"),
          false,
          args.dryRun === true,
        );
      }

      if (name === "article.publishMarkdown") {
        const markdownPath = readNonEmptyString(args, "markdownPath");
        if (!markdownPath) {
          return errorResult("VALIDATION_ERROR", "markdownPath is required");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        return await createWeiboArticleFromMarkdown(
          page,
          markdownPath,
          readNonEmptyString(args, "title"),
          readNonEmptyString(args, "lead"),
          readNonEmptyString(args, "coverImagePath"),
          true,
          args.dryRun === true,
        );
      }

      if (name === "post.replies.list") {
        const url = readNonEmptyString(args, "url");
        const id = readNonEmptyString(args, "id");
        const cursor = readNonEmptyString(args, "cursor");
        if (!url && !id) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const targetUrl = url ?? buildPostUrl(id as string);
        if (!isAllowedWeiboUrl(targetUrl)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within weibo.com hosts");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        const targetId = id ?? targetUrl.match(/(\d{8,})/)?.[1];
        if (targetId) {
          const networkResult = await readPostRepliesViaNetwork(page, targetId, cursor);
          if (networkResult.source === "network") {
            return {
              items: networkResult.items,
              hasMore: Boolean(networkResult.nextCursor),
              source: "network",
              ...(networkResult.nextCursor ? { nextCursor: networkResult.nextCursor } : {}),
              ...(networkResult.reason ? { reason: networkResult.reason } : {}),
            };
          }
        }
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
        const items = await extractVisibleComments(page, 10);
        return {
          items,
          hasMore: false,
          source: "dom",
        };
      }

      if (name === "post.repost.list") {
        const url = readNonEmptyString(args, "url");
        const id = readNonEmptyString(args, "id");
        const cursor = readNonEmptyString(args, "cursor");
        const pageNo = cursor ? Number.parseInt(cursor, 10) : 1;
        if (!url && !id) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        if (cursor && (!Number.isInteger(pageNo) || pageNo < 1)) {
          return errorResult("VALIDATION_ERROR", "cursor must be a positive integer page number");
        }
        const targetUrl = url ?? buildPostUrl(id as string);
        if (!isAllowedWeiboUrl(targetUrl)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within weibo.com hosts");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }
        const targetId = id ?? targetUrl.match(/(\d{8,})/)?.[1];
        if (targetId) {
          const networkResult = await readPostRepostsViaNetwork(page, targetId, cursor);
          if (networkResult.source === "network") {
            return {
              items: networkResult.items,
              hasMore: Boolean(networkResult.nextCursor),
              source: "network",
              ...(networkResult.nextCursor ? { nextCursor: networkResult.nextCursor } : {}),
              ...(networkResult.reason ? { reason: networkResult.reason } : {}),
            };
          }
        }
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
        const items = await extractVisibleReposts(page, DEFAULT_TIMELINE_LIMIT);
        return {
          items,
          hasMore: false,
          source: "dom",
        };
      }

      if (name === "user.get") {
        const url = readNonEmptyString(args, "url");
        const screenName = readNonEmptyString(args, "screenName");
        if (!url && !screenName) {
          return errorResult("VALIDATION_ERROR", "url or screenName is required");
        }
        const targetUrl = url ?? buildProfileUrl(screenName as string);
        if (!isAllowedWeiboUrl(targetUrl)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within weibo.com hosts");
        }

        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }

        const targetUid = url ? parseUserIdFromUrl(targetUrl) : undefined;
        if (targetUid) {
          const networkResult = await readUserViaNetwork(page, targetUid);
          if (networkResult.user) {
            return {
              user: networkResult.user,
              source: networkResult.source,
              ...maybeReason(networkResult.reason),
            };
          }
        }

        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
        const user = await extractUserProfile(page);
        if (!user) {
          return errorResult("UPSTREAM_CHANGED", "unable to locate the target Weibo profile");
        }
        return {
          user,
          source: "dom",
        };
      }

      if (name === "user.posts.list") {
        const uid = readNonEmptyString(args, "uid");
        const url = readNonEmptyString(args, "url");
        const screenName = readNonEmptyString(args, "screenName");
        const cursor = readNonEmptyString(args, "cursor");
        const pageCursor = readPositivePageCursor(cursor);
        if (!uid && !url && !screenName) {
          return errorResult("VALIDATION_ERROR", "uid, url, or screenName is required");
        }
        if (pageCursor === null) {
          return errorResult("VALIDATION_ERROR", "cursor must be a positive integer page number");
        }
        const authError = await ensureAuthenticated(page);
        if (authError) {
          return authError;
        }

        const targetUrl = url ?? (screenName ? buildProfileUrl(screenName) : uid ? `https://weibo.com/u/${encodeURIComponent(uid)}` : undefined);
        if (targetUrl && !isAllowedWeiboUrl(targetUrl)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within weibo.com hosts");
        }

        const resolvedUid = uid ?? (targetUrl ? parseUserIdFromUrl(targetUrl) : undefined);
        if (resolvedUid) {
          const networkResult = await readUserPostsViaNetwork(page, resolvedUid, pageCursor);
          if (networkResult.source === "network" && networkResult.items.length > 0) {
            return {
              items: networkResult.items,
              hasMore: Boolean(networkResult.nextCursor),
              source: "network",
              ...(networkResult.nextCursor ? { nextCursor: networkResult.nextCursor } : {}),
              ...maybeReason(networkResult.reason),
            };
          }
        }

        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or screenName is required when uid cannot be resolved from input");
        }
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
        const items = await collectTimelineItems(page, DEFAULT_TIMELINE_LIMIT);
        return {
          items,
          hasMore: false,
          source: "dom",
        };
      }

      if (name === "search.weibo") {
        const query = readNonEmptyString(args, "query");
        const cursor = readNonEmptyString(args, "cursor");
        const limit = readLimit(args) ?? DEFAULT_TIMELINE_LIMIT;
        const pageCursor = readPositivePageCursor(cursor);
        if (!query) {
          return errorResult("VALIDATION_ERROR", "query is required");
        }
        if (pageCursor === null) {
          return errorResult("VALIDATION_ERROR", "cursor must be a positive integer page number");
        }
        const pageNo = pageCursor ? Number.parseInt(pageCursor, 10) : 1;

        const searchUrl = new URL("https://s.weibo.com/weibo");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("Refer", "weibo_weibo");
        if (pageNo > 1) {
          searchUrl.searchParams.set("page", String(pageNo));
        }

        const requestResult = await readSearchResultsViaRequest(page, searchUrl.toString(), limit);
        if (requestResult) {
          return {
            query,
            items: requestResult.items,
            hasMore: requestResult.hasMore,
            source: "dom",
            ...(requestResult.nextCursor ? { nextCursor: requestResult.nextCursor } : {}),
          };
        }

        const result = await withEphemeralReadPage(page, searchUrl.toString(), async (readPage) => {
          await settleReadPage(readPage);
          return await retryOnNavigationRace(readPage, async () => await extractSearchResults(readPage, limit));
        });
        return {
          query,
          items: result.items,
          hasMore: result.hasMore,
          source: "dom",
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      }

      if (name === "search.ai.summary") {
        const query = readNonEmptyString(args, "query");
        if (!query) {
          return errorResult("VALIDATION_ERROR", "query is required");
        }

        const networkResult = await readAiSearchSummaryViaNetwork(page, query);
        if (networkResult.result?.summary || networkResult.result) {
          return {
            ...networkResult.result,
            source: "network",
            ...maybeReason(networkResult.reason),
          };
        }

        const searchUrl = new URL("https://s.weibo.com/aisearch");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("Refer", "weibo_aisearch");
        await page.goto(searchUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
        const summary = await extractAiSearchSummary(page, query);
        if (!summary) {
          return errorResult("UPSTREAM_CHANGED", "unable to locate the Weibo AI search summary");
        }
        return {
          ...summary,
          source: "dom",
          ...maybeReason(networkResult.reason, { includeInvalidResponse: true }),
        };
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
  };
}
