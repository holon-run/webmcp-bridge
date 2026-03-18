/**
 * This module implements the X site fallback adapter with robust auth checks and compose confirmation.
 * It depends on Playwright page evaluation and shared adapter contracts to execute browser-side tool actions.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { SiteAdapter, WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import {
  buildRequestCaptureInitScript,
  captureRoutedResponseText,
  collectTextByTag,
  joinTextParts,
  parseNdjsonLines,
  type RequestTemplate,
  TemplateCache,
} from "@webmcp-bridge/adapter-utils";
import type { Page } from "playwright";

type XAuthState = "authenticated" | "auth_required" | "challenge_required";

type AuthProbeResult = {
  state: XAuthState;
  signals: string[];
};

type ComposeDomResult = {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  submitVisible?: boolean;
};

type GrokComposeDomResult = {
  ok: boolean;
  reason?: string;
};

type ReplyComposeDomResult = {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  submitVisible?: boolean;
};

type SubmitDomResult = {
  ok: boolean;
  reason?: string;
};

export type CreateXAdapterOptions = {
  composeConfirmTimeoutMs?: number;
  grokResponseTimeoutMs?: number;
  maxPostLength?: number;
};

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 20;
const MAX_READ_PAGE_CACHE_SIZE = 8;
const DEFAULT_COMPOSE_CONFIRM_TIMEOUT_MS = 10_000;
const DEFAULT_GROK_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_POST_LENGTH = 280;
const AUTH_STABILIZE_ATTEMPTS = 6;
const AUTH_STABILIZE_DELAY_MS = 750;
const AUTH_WARMUP_TIMEOUT_MS = 12_000;

const CAPTURE_INJECT_SCRIPT = buildRequestCaptureInitScript({
  globalKey: "__WEBMCP_X_CAPTURE__",
  shouldCaptureSource: String.raw`((url) => {
    if (typeof url !== "string") return false;
    return (
      url.includes("/i/api/graphql/") &&
      (
        url.includes("/HomeTimeline") ||
        url.includes("/Bookmarks") ||
        url.includes("/BookmarksAll") ||
        url.includes("/TweetDetail") ||
        url.includes("/UserTweets") ||
        url.includes("/UserMedia") ||
        url.includes("/UserTweetsAndReplies") ||
        url.includes("/SearchTimeline")
      )
    );
  })`,
  enrichEntrySource: String.raw`((entry) => {
    const url = typeof entry?.url === "string" ? entry.url : "";
    let op = "Unknown";
    if (url.includes("/HomeTimeline")) op = "HomeTimeline";
    else if (url.includes("/BookmarksAll")) op = "BookmarksAll";
    else if (url.includes("/Bookmarks")) op = "Bookmarks";
    else if (url.includes("/TweetDetail")) op = "TweetDetail";
    else if (url.includes("/UserTweetsAndReplies")) op = "UserTweetsAndReplies";
    else if (url.includes("/UserMedia")) op = "UserMedia";
    else if (url.includes("/UserTweets")) op = "UserTweets";
    else if (url.includes("/SearchTimeline")) op = "SearchTimeline";
    return { ...entry, op };
  })`,
  maxEntries: 80,
});

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "auth.get",
    description: "Detect login/challenge state",
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
    description: "Read home timeline tweet cards",
    inputSchema: {
      type: "object",
      description: "List tweets from your home timeline. Supports cursor pagination.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.get",
    description: "Read one tweet by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch a single tweet using full URL or tweet id.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.thread.get",
    description: "Read one tweet thread by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch the focal tweet and nearby replies from a tweet detail thread.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        limit: {
          type: "integer",
          description: `Maximum number of thread tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "favorites.list",
    description: "Read bookmarks/favorites feed cards",
    inputSchema: {
      type: "object",
      description: "List tweets from bookmarks/favorites. Supports cursor pagination.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "notifications.list",
    description: "Read the main notifications feed",
    inputSchema: {
      type: "object",
      description: "List recent notifications from the authenticated account.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of notifications to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "mentions.list",
    description: "Read the mentions tab from notifications",
    inputSchema: {
      type: "object",
      description: "List recent mention notifications where the account is referenced.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of mentions to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "timeline.user.list",
    description: "Read one user's timeline tweet cards",
    inputSchema: {
      type: "object",
      description: "List tweets from a target user's profile timeline. Supports cursor pagination.",
      properties: {
        username: {
          type: "string",
          minLength: 1,
          description: "X username, with or without leading @.",
        },
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "search.tweets.list",
    description: "Read search tweets list",
    inputSchema: {
      type: "object",
      description: "Search tweets by query. Supports cursor pagination.",
      properties: {
        query: { type: "string", minLength: 1, description: "Search query text." },
        mode: {
          type: "string",
          description: "Search ranking mode. Use latest for reverse-chronological results.",
          enum: ["top", "latest"],
        },
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
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
    name: "user.get",
    description: "Read a user profile summary by handle",
    inputSchema: {
      type: "object",
      description: "Read public profile information for one user.",
      properties: {
        handle: {
          type: "string",
          minLength: 1,
          description: "User handle, with or without leading @.",
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.create",
    description: "Publish a short text post",
    inputSchema: {
      type: "object",
      description: "Create a new post from the currently logged-in account.",
      properties: {
        text: {
          type: "string",
          description: `Post text content. Max length ${DEFAULT_MAX_POST_LENGTH}.`,
          minLength: 1,
          maxLength: DEFAULT_MAX_POST_LENGTH,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate compose path without submitting.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "tweet.reply",
    description: "Reply to one tweet by url or id",
    inputSchema: {
      type: "object",
      description: "Open a tweet detail page, compose one reply, and optionally skip final submit with dryRun.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        text: {
          type: "string",
          description: `Reply text content. Max length ${DEFAULT_MAX_POST_LENGTH}.`,
          minLength: 1,
          maxLength: DEFAULT_MAX_POST_LENGTH,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate the reply compose path without submitting.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "grok.chat",
    description: "Send one prompt to Grok from the authenticated X session",
    inputSchema: {
      type: "object",
      description:
        "Ask Grok from the authenticated X session. Starts a new chat by default; pass conversationId to continue an existing conversation.",
      properties: {
        prompt: {
          type: "string",
          description: "Prompt text to send to Grok.",
          minLength: 1,
        },
        conversationId: {
          type: "string",
          description: "Existing Grok conversation id. When omitted, the adapter starts a new chat before asking.",
          minLength: 1,
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

function toRecord(value: JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorResult(code: string, message: string, details?: JsonValue): JsonValue {
  const error: Record<string, JsonValue> = {
    code,
    message,
  };
  if (details !== undefined) {
    error.details = details;
  }
  return { error };
}

function normalizeTimelineLimit(input: Record<string, unknown>): number {
  const rawLimit = input.limit;
  if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)) {
    return DEFAULT_TIMELINE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(rawLimit)));
}

async function ensureNetworkCaptureInstalled(page: Page): Promise<void> {
  await page.addInitScript(CAPTURE_INJECT_SCRIPT);
  await page.evaluate(CAPTURE_INJECT_SCRIPT);
}

type TimelineMode = "home" | "bookmarks" | "tweet" | "user_timeline" | "search";

async function hasCapturedTemplate(page: Page, mode: TimelineMode): Promise<boolean> {
  const result = await page.evaluate(({ targetMode }) => {
    const globalAny = window as unknown as {
      __WEBMCP_X_CAPTURE__?: {
        entries?: Array<{ op?: string }>;
      };
    };
    const entries = Array.isArray(globalAny.__WEBMCP_X_CAPTURE__?.entries)
      ? globalAny.__WEBMCP_X_CAPTURE__?.entries ?? []
      : [];
    const ops =
      targetMode === "home"
        ? ["HomeTimeline", "TweetDetail"]
        : targetMode === "bookmarks"
          ? ["BookmarksAll", "Bookmarks"]
          : targetMode === "tweet"
            ? ["TweetDetail"]
            : targetMode === "user_timeline"
              ? ["UserTweets", "UserTweetsAndReplies", "UserMedia"]
              : ["SearchTimeline"];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry && typeof entry.op === "string" && ops.includes(entry.op)) {
        return true;
      }
    }
    return false;
  }, { targetMode: mode });
  return result === true;
}

async function warmupNetworkTemplate(page: Page, mode: Exclude<TimelineMode, "tweet">): Promise<void> {
  if (await hasCapturedTemplate(page, mode)) {
    return;
  }
  await waitForTweetSurface(page);
  await page
    .evaluate(() => {
      window.scrollTo(0, Math.max(document.body.scrollHeight * 0.8, 1200));
    })
    .catch(() => {});
  await page.waitForTimeout(900);
  if (await hasCapturedTemplate(page, mode)) {
    return;
  }
  await page
    .evaluate(() => {
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(700);
  if (await hasCapturedTemplate(page, mode)) {
    return;
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForTweetSurface(page);
}

async function detectAuth(page: Page): Promise<AuthProbeResult> {
  return await page.evaluate(({ op }: { op: string }): AuthProbeResult => {
    void op;
    const signals: string[] = [];

    const challengeSelectors = [
      "form[action*='account/access']",
      "input[name='verification_string']",
      "iframe[title*='challenge']",
    ];
    const loginSelectors = [
      "input[name='text']",
      "input[autocomplete='username']",
      "a[href='/login']",
      "a[href*='/i/flow/login']",
    ];
    const authenticatedSelectors = [
      "[data-testid='AppTabBar_Home_Link']",
      "[data-testid='SideNav_NewTweet_Button']",
      "[data-testid='tweetTextarea_0']",
      "nav[aria-label='Primary']",
    ];

    const hasSelector = (selectors: string[]): boolean => {
      return selectors.some((selector) => document.querySelector(selector) !== null);
    };

    const bodyText = (document.body?.innerText ?? "").toLowerCase();
    const pathname = location.pathname.toLowerCase();

    const hasChallengeUi =
      hasSelector(challengeSelectors) ||
      pathname.includes("/account/access") ||
      bodyText.includes("are you human") ||
      bodyText.includes("unusual activity") ||
      bodyText.includes("challenge");

    if (hasChallengeUi) {
      signals.push("challenge_ui");
      return { state: "challenge_required", signals };
    }

    if (hasSelector(authenticatedSelectors)) {
      signals.push("authenticated_ui");
      return { state: "authenticated", signals };
    }

    if (hasSelector(loginSelectors) || pathname.includes("/login") || pathname.includes("/i/flow/login")) {
      signals.push("login_ui");
      return { state: "auth_required", signals };
    }

    signals.push("auth_unknown");
    return { state: "auth_required", signals };
  }, { op: "detect_auth" });
}

async function detectAuthStable(page: Page): Promise<AuthProbeResult> {
  let auth = await detectAuth(page);
  for (let attempt = 1; attempt < AUTH_STABILIZE_ATTEMPTS; attempt += 1) {
    const shouldRetry = auth.state === "auth_required" && auth.signals.includes("auth_unknown");
    if (!shouldRetry) {
      return auth;
    }
    await page.waitForTimeout(AUTH_STABILIZE_DELAY_MS);
    auth = await detectAuth(page);
  }
  return auth;
}

async function warmupAuthProbe(page: Page): Promise<void> {
  const deadline = Date.now() + AUTH_WARMUP_TIMEOUT_MS;
  for (;;) {
    const auth = await detectAuth(page);
    const stable = !(auth.state === "auth_required" && auth.signals.includes("auth_unknown"));
    if (stable || Date.now() >= deadline) {
      return;
    }
    await page.waitForTimeout(AUTH_STABILIZE_DELAY_MS);
  }
}

type TweetCard = {
  id: string;
  text: string;
  url?: string;
  author?: string;
  createdAt?: string;
};

type TimelineItem = {
  id: string;
  text: string;
  url?: string;
  kind?: string;
  summary?: string;
  tweetText?: string;
};

type TimelinePage = {
  items: TimelineItem[];
  source: "network" | "dom";
  hasMore: boolean;
  nextCursor?: string;
  debug?: {
    reason: string;
  };
};

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function enrichNotificationItem(item: TimelineItem): TimelineItem {
  const text = normalizeInlineText(item.text);
  const summary = item.summary ? normalizeInlineText(item.summary) : undefined;
  const tweetText = item.tweetText ? normalizeInlineText(item.tweetText) : undefined;
  const next: TimelineItem = {
    id: item.id,
    text,
  };
  if (item.url) {
    next.url = item.url;
  }
  if (summary) {
    next.summary = summary;
  }
  if (tweetText) {
    next.tweetText = tweetText;
  }
  if (item.kind) {
    next.kind = item.kind;
  }

  const likeMatch = text.match(/^(.+?liked your post·\s*\S+)\s+(?:Article\s+)?(.+)$/i);
  if (likeMatch?.[1] && likeMatch[2]) {
    next.kind = next.kind ?? "like";
    next.summary = next.summary ?? normalizeInlineText(likeMatch[1]);
    next.tweetText = next.tweetText ?? normalizeInlineText(likeMatch[2]);
    next.text = next.tweetText;
    return next;
  }

  const repostMatch = text.match(/^(.+?reposted(?: your post)?·\s*\S+)\s+(.+)$/i);
  if (repostMatch?.[1] && repostMatch[2]) {
    next.kind = next.kind ?? "repost";
    next.summary = next.summary ?? normalizeInlineText(repostMatch[1]);
    next.tweetText = next.tweetText ?? normalizeInlineText(repostMatch[2]);
    next.text = next.tweetText;
    return next;
  }

  const replyMatch = text.match(/^(.+?Replying to @\w+(?:.*?·\s*\S+)?)\s+(.+)$/i);
  if (replyMatch?.[1] && replyMatch[2]) {
    next.kind = next.kind ?? "reply";
    next.summary = next.summary ?? normalizeInlineText(replyMatch[1]);
    next.tweetText = next.tweetText ?? normalizeInlineText(replyMatch[2]);
    next.text = next.tweetText;
    return next;
  }

  const followMatch = text.match(/^(.+?followed you(?:·\s*\S+)?)$/i);
  if (followMatch?.[1]) {
    next.kind = next.kind ?? "follow";
    next.summary = next.summary ?? normalizeInlineText(followMatch[1]);
    return next;
  }

  if (!next.kind && next.url) {
    next.kind = "mention";
  }
  return next;
}

type ReadPageKey = string;
type ProcessTemplateBucket = TimelineMode;

type ReadPageCacheEntry = {
  key: string;
  page: Page;
};

type ReadPageCacheState = {
  pages: Map<string, ReadPageCacheEntry>;
  lru: string[];
};

const READ_PAGE_CACHE = new WeakMap<Page, ReadPageCacheState>();
const PROCESS_TEMPLATE_CACHE = new TemplateCache<ProcessTemplateBucket, RequestTemplate>();

async function readTimelineViaNetwork(
  page: Page,
  options: {
    mode: TimelineMode;
    limit: number;
    cursor?: string;
    tweetId?: string;
  },
): Promise<{ items: TweetCard[]; nextCursor?: string; source: "network" | "dom"; reason?: string }> {
  const fallbackTemplate = PROCESS_TEMPLATE_CACHE.get(options.mode);
  const response = await page.evaluate(
    async ({ mode, limit, cursor: inputCursor, tweetId, cachedTemplate }) => {
      const globalAny = window as unknown as {
        __WEBMCP_X_CAPTURE__?: {
          entries?: Array<{
            op?: string;
            url?: string;
            method?: string;
            headers?: Record<string, string>;
            body?: string;
            responseJson?: unknown;
          }>;
        };
      };

      const capture = globalAny.__WEBMCP_X_CAPTURE__;
      const entries = Array.isArray(capture?.entries) ? capture.entries : [];

      const pickTemplate = (): {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      } | null => {
        const acceptOps =
          mode === "home"
            ? ["HomeTimeline", "TweetDetail"]
            : mode === "bookmarks"
              ? ["BookmarksAll", "Bookmarks"]
              : mode === "tweet"
                ? ["TweetDetail"]
                : mode === "user_timeline"
                  ? ["UserTweets", "UserTweetsAndReplies", "UserMedia"]
                  : ["SearchTimeline"];

        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const entry = entries[i];
          if (!entry || !entry.op || !entry.url || !entry.method) {
            continue;
          }
          if (!acceptOps.includes(entry.op)) {
            continue;
          }
          const output: {
            url: string;
            method: string;
            headers: Record<string, string>;
            body?: string;
          } = {
            url: entry.url,
            method: entry.method,
            headers: entry.headers ?? {},
          };
          if (entry.body !== undefined) {
            output.body = entry.body;
          }
          return output;
        }
        return null;
      };

      const template = pickTemplate() ?? cachedTemplate ?? null;
      if (!template) {
        return { items: [], source: "dom" as const, reason: "no_template" };
      }

      const parseJsonSafely = (value: string | null): Record<string, unknown> => {
        if (!value) {
          return {};
        }
        try {
          const parsed = JSON.parse(value);
          return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      };

      const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

      const collectFromResult = (input: unknown): { items: TweetCard[]; nextCursor?: string } => {
        const outputItems: TweetCard[] = [];
        const seen = new Set<string>();
        let nextCursor: string | undefined;

        const visit = (value: unknown): void => {
          if (!value || typeof value !== "object") {
            return;
          }
          if (Array.isArray(value)) {
            for (const item of value) {
              visit(item);
            }
            return;
          }
          const record = value as Record<string, unknown>;
          const entryId = typeof record.entryId === "string" ? record.entryId : "";
          const content = (record.content ?? {}) as Record<string, unknown>;
          const entryType = typeof content.entryType === "string" ? content.entryType : "";

          if (!nextCursor && entryType === "TimelineTimelineCursor") {
            const cursorType = typeof content.cursorType === "string" ? content.cursorType : "";
            const cursorValue = typeof content.value === "string" ? content.value : "";
            if (cursorType.toLowerCase().includes("bottom") && cursorValue) {
              nextCursor = cursorValue;
            }
          }

          if (entryId.includes("cursor-bottom") && !nextCursor) {
            const cursorValue = typeof content.value === "string" ? content.value : "";
            if (cursorValue) {
              nextCursor = cursorValue;
            }
          }

          const contentItem = (content.item as Record<string, unknown> | undefined) ?? undefined;
          const contentItemContent = (contentItem?.itemContent as Record<string, unknown> | undefined) ?? undefined;
          const itemContent = (content.itemContent as Record<string, unknown> | undefined) ?? contentItemContent;
          const tweetResults = (itemContent?.tweet_results as Record<string, unknown> | undefined)?.result;
          let tweet = tweetResults as Record<string, unknown> | undefined;
          if (tweet && typeof tweet === "object" && "tweet" in tweet) {
            tweet = tweet.tweet as Record<string, unknown>;
          }
          const restId = typeof tweet?.rest_id === "string" ? tweet.rest_id : "";
          const legacy = (tweet?.legacy as Record<string, unknown> | undefined) ?? {};
          const fullText =
            typeof legacy.full_text === "string"
              ? legacy.full_text
              : typeof legacy.text === "string"
                ? legacy.text
                : "";
          const noteText =
            (((tweet?.note_tweet as Record<string, unknown> | undefined)?.note_tweet_results as Record<string, unknown> | undefined)
              ?.result as Record<string, unknown> | undefined)?.text;
          const text = normalizeText(typeof noteText === "string" && noteText ? noteText : fullText);

          if (restId && text) {
            const userResult = (((tweet?.core as Record<string, unknown> | undefined)?.user_results as Record<string, unknown> | undefined)
              ?.result as Record<string, unknown> | undefined) ?? {};
            const userLegacy = (userResult.legacy as Record<string, unknown> | undefined) ?? {};
            const screenName = typeof userLegacy.screen_name === "string" ? userLegacy.screen_name : "";
            const authorName = typeof userLegacy.name === "string" ? userLegacy.name : "";
            const createdAt = typeof legacy.created_at === "string" ? legacy.created_at : undefined;
            const key = `${restId}:${text}`;
            if (!seen.has(key)) {
              seen.add(key);
              const item: TweetCard = {
                id: restId,
                text,
              };
              if (screenName) {
                item.url = `https://x.com/${screenName}/status/${restId}`;
                item.author = authorName ? `${authorName}@${screenName}` : `@${screenName}`;
              }
              if (createdAt) {
                item.createdAt = createdAt;
              }
              outputItems.push(item);
            }
          }

          for (const nested of Object.values(record)) {
            visit(nested);
          }
        };

        visit(input);
        const result: { items: TweetCard[]; nextCursor?: string } = { items: outputItems };
        if (nextCursor !== undefined) {
          result.nextCursor = nextCursor;
        }
        return result;
      };

      const sanitizeHeaders = (headers?: Record<string, string>): Record<string, string> => {
        const blockedPrefixes = ["sec-", ":"];
        const blockedExact = new Set(["host", "content-length", "cookie", "origin", "referer", "connection"]);
        const output: Record<string, string> = {};
        if (!headers) {
          return output;
        }
        for (const [key, value] of Object.entries(headers)) {
          const k = key.toLowerCase();
          if (blockedExact.has(k)) {
            continue;
          }
          if (blockedPrefixes.some((prefix) => k.startsWith(prefix))) {
            continue;
          }
          output[k] = value;
        }
        return output;
      };

      const templateUrl = new URL(template.url, location.origin);
      const templateVariables = parseJsonSafely(templateUrl.searchParams.get("variables"));
      const templateFeatures = parseJsonSafely(templateUrl.searchParams.get("features"));
      const templateFieldToggles = parseJsonSafely(templateUrl.searchParams.get("fieldToggles"));
      const headers = sanitizeHeaders(template.headers);

      const cursor: string | undefined = typeof inputCursor === "string" && inputCursor ? inputCursor : undefined;

      const createRequestUrl = (): string => {
        const vars = { ...templateVariables };
        if (mode === "tweet" && tweetId) {
          vars.focalTweetId = tweetId;
        }
        vars.count = Math.max(20, limit);
        if (cursor) {
          vars.cursor = cursor;
        } else {
          delete vars.cursor;
        }
        const next = new URL(template.url, location.origin);
        next.searchParams.set("variables", JSON.stringify(vars));
        if (Object.keys(templateFeatures).length > 0) {
          next.searchParams.set("features", JSON.stringify(templateFeatures));
        }
        if (Object.keys(templateFieldToggles).length > 0) {
          next.searchParams.set("fieldToggles", JSON.stringify(templateFieldToggles));
        }
        return next.toString();
      };

      const requestUrl = createRequestUrl();
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          method: template.method,
          headers,
          credentials: "include",
        });
      } catch {
        return { items: [], source: "dom" as const, reason: "request_failed" };
      }
      if (!response.ok) {
        return {
          items: [],
          source: "dom" as const,
          reason: `http_error_${response.status}`,
        };
      }
      let responseJson: unknown;
      try {
        responseJson = await response.json();
      } catch {
        return { items: [], source: "dom" as const, reason: "response_parse_failed" };
      }

      const parsed = collectFromResult(responseJson);
      const result: {
        items: TweetCard[];
        nextCursor?: string;
        source: "network" | "dom";
        reason?: string;
        selectedTemplate?: RequestTemplate;
      } = {
        items: parsed.items.slice(0, limit),
        source: parsed.items.length > 0 ? ("network" as const) : ("dom" as const),
        selectedTemplate: template,
      };
      if (parsed.nextCursor) {
        result.nextCursor = parsed.nextCursor;
      }
      if (parsed.items.length === 0) {
        result.reason = "empty_result";
      }
      return result;
    },
    {
      mode: options.mode,
      limit: options.limit,
      cursor: options.cursor,
      tweetId: options.tweetId,
      cachedTemplate: fallbackTemplate,
    },
  );

  if (
    !response ||
    typeof response !== "object" ||
    !("items" in response) ||
    !Array.isArray((response as { items?: unknown }).items)
  ) {
    return { items: [], source: "dom", reason: "invalid_response" };
  }
  const typed = response as {
    items: TweetCard[];
    nextCursor?: string;
    source: "network" | "dom";
    reason?: string;
    selectedTemplate?: {
      url?: unknown;
      method?: unknown;
      headers?: unknown;
      body?: unknown;
    };
  };

  const selectedTemplate = typed.selectedTemplate;
  if (
    selectedTemplate &&
    typeof selectedTemplate.url === "string" &&
    typeof selectedTemplate.method === "string"
  ) {
    const cacheValue: RequestTemplate = {
      url: selectedTemplate.url,
      method: selectedTemplate.method,
    };
    if (
      typeof selectedTemplate.headers === "object" &&
      selectedTemplate.headers !== null &&
      !Array.isArray(selectedTemplate.headers)
    ) {
      cacheValue.headers = selectedTemplate.headers as Record<string, string>;
    }
    if (typeof selectedTemplate.body === "string") {
      cacheValue.body = selectedTemplate.body;
    }
    PROCESS_TEMPLATE_CACHE.set(options.mode, cacheValue);
  }

  const result: { items: TweetCard[]; nextCursor?: string; source: "network" | "dom"; reason?: string } = {
    items: typed.items,
    source: typed.source,
  };
  if (typeof typed.nextCursor === "string" && typed.nextCursor.length > 0) {
    result.nextCursor = typed.nextCursor;
  }
  if (typeof typed.reason === "string" && typed.reason.length > 0) {
    result.reason = typed.reason;
  }
  return result;
}

async function extractTweetCards(
  page: Page,
  limit: number,
): Promise<Array<{ id: string; text: string; url?: string; author?: string; createdAt?: string }>> {
  const cards = await page.evaluate(({ maxItems }: { maxItems: number }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const dedupe = new Set<string>();
    const items: Array<{ id: string; text: string; url?: string; author?: string; createdAt?: string }> = [];
    const pushItem = (item: { id: string; text: string; url?: string; author?: string; createdAt?: string }): void => {
      const dedupeKey = `${item.id}:${item.text}`;
      if (!item.text || dedupe.has(dedupeKey)) {
        return;
      }
      dedupe.add(dedupeKey);
      items.push(item);
    };

    const articles = Array.from(document.querySelectorAll<HTMLElement>("article"));
    for (const article of articles) {
      const statusAnchor = article.querySelector<HTMLAnchorElement>("a[href*='/status/']");
      const url = statusAnchor?.href;
      const id = url?.match(/status\/(\d+)/)?.[1] ?? `article-${items.length + 1}`;

      const textNodes = Array.from(article.querySelectorAll<HTMLElement>("[data-testid='tweetText'], div[lang], div[dir='auto']"));
      const mergedText = normalize(textNodes.map((n) => n.textContent || "").join(" "));
      const fallbackText = normalize(article.textContent || "");
      const text = mergedText || fallbackText;
      if (!text) {
        continue;
      }

      const authorRaw = article.querySelector<HTMLElement>("[data-testid='User-Name']")?.textContent ?? "";
      const createdAtRaw = article.querySelector<HTMLTimeElement>("time")?.dateTime ?? "";
      const item: { id: string; text: string; url?: string; author?: string; createdAt?: string } = { id, text };
      if (url) {
        item.url = url;
      }
      const author = normalize(authorRaw);
      if (author) {
        item.author = author;
      }
      if (createdAtRaw) {
        item.createdAt = createdAtRaw;
      }
      pushItem(item);
      if (items.length >= maxItems) {
        break;
      }
    }

    if (items.length < maxItems) {
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='cellInnerDiv']"));
      for (const cell of cells) {
        if (items.length >= maxItems) {
          break;
        }
        const text = normalize(cell.innerText || cell.textContent || "");
        if (!text || text.length < 16) {
          continue;
        }
        const statusAnchor = cell.querySelector<HTMLAnchorElement>("a[href*='/status/']");
        const url = statusAnchor?.href;
        const id = url?.match(/status\/(\d+)/)?.[1] ?? `cell-${items.length + 1}`;
        const item: { id: string; text: string; url?: string } = { id, text };
        if (url) {
          item.url = url;
        }
        pushItem(item);
      }
    }

    if (items.length === 0) {
      const bodyText = normalize(document.body?.innerText || "");
      if (bodyText) {
        const snippet = bodyText.slice(0, 280);
        pushItem({
          id: "fallback-body-1",
          text: snippet,
        });
      }
    }
    return items;
  }, { maxItems: limit });
  return cards;
}

async function extractNotificationCards(
  page: Page,
  limit: number,
): Promise<Array<{ id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string }>> {
  return await page.evaluate(({ op, maxItems }) => {
    if (op !== "extract_notifications") {
      return [];
    }

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const classifySummary = (value: string): string => {
      const text = value.toLowerCase();
      if (text.includes("followed you")) return "follow";
      if (text.includes("liked your post")) return "like";
      if (text.includes("reposted your post") || text.includes("reposted")) return "repost";
      if (text.includes("replying to @") || text.includes("replied")) return "reply";
      if (text.includes("@")) return "mention";
      return "notification";
    };
    const isGenericHelperText = (value: string): boolean => {
      const text = value.toLowerCase();
      return (
        text.includes("control which conversations you're mentioned in") ||
        text.includes("control which conversations you’re mentioned in") ||
        (text.includes("learn more") && text.includes("mentioned"))
      );
    };
    const scoreItem = (value: { text: string; summary?: string; tweetText?: string }): number => {
      const text = normalize(value.text);
      let score = text.length;
      if (value.summary) {
        score += 100;
      }
      if (value.tweetText) {
        score += 60;
      }
      return score;
    };
    const pickPreferred = (
      current:
        | { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string }
        | undefined,
      next: { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string },
    ): { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string } => {
      if (!current) {
        return next;
      }
      return scoreItem(next) > scoreItem(current) ? next : current;
    };

    const byKey = new Map<
      string,
      { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string }
    >();
    const pushItem = (item: {
      id: string;
      text: string;
      url?: string;
      kind?: string;
      summary?: string;
      tweetText?: string;
    }): void => {
      const text = normalize(item.text);
      if (!text || isGenericHelperText(text)) {
        return;
      }
      const normalizedItem: {
        id: string;
        text: string;
        url?: string;
        kind?: string;
        summary?: string;
        tweetText?: string;
      } = {
        id: item.id,
        text,
      };
      if (item.url) {
        normalizedItem.url = item.url;
      }
      if (item.kind) {
        normalizedItem.kind = item.kind;
      }
      if (item.summary) {
        normalizedItem.summary = normalize(item.summary);
      }
      if (item.tweetText) {
        normalizedItem.tweetText = normalize(item.tweetText);
      }
      const dedupeKey = item.url ? `url:${item.url}` : `text:${text.toLowerCase()}`;
      byKey.set(dedupeKey, pickPreferred(byKey.get(dedupeKey), normalizedItem));
    };

    const articles = Array.from(document.querySelectorAll<HTMLElement>("article"));
    for (const article of articles) {
      const statusAnchor = article.querySelector<HTMLAnchorElement>("a[href*='/status/']");
      const url = statusAnchor?.href;
      const id = url?.match(/status\/(\d+)/)?.[1] ?? `article-${byKey.size + 1}`;
      const textNodes = Array.from(article.querySelectorAll<HTMLElement>("[data-testid='tweetText'], div[lang], div[dir='auto']"));
      const tweetText = normalize(textNodes.map((node) => node.textContent || "").join(" "));
      const fallbackText = normalize(article.innerText || article.textContent || "");
      const summary = tweetText ? normalize(fallbackText.replace(tweetText, "")) : "";
      const item: { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string } = {
        id,
        text: tweetText || fallbackText,
      };
      if (url) {
        item.url = url;
      }
      if (summary) {
        item.summary = summary;
        item.kind = classifySummary(summary);
      }
      if (tweetText) {
        item.tweetText = tweetText;
      }
      pushItem(item);
    }

    if (byKey.size < maxItems) {
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='cellInnerDiv']"));
      for (const cell of cells) {
        const fallbackText = normalize(cell.innerText || cell.textContent || "");
        const tweetNode = cell.querySelector<HTMLElement>("[data-testid='tweetText'], div[lang], div[dir='auto']");
        const tweetText = normalize(tweetNode?.innerText || tweetNode?.textContent || "");
        const summary = tweetText ? normalize(fallbackText.replace(tweetText, "")) : "";
        const statusAnchor = cell.querySelector<HTMLAnchorElement>("a[href*='/status/']");
        const url = statusAnchor?.href;
        const id = url?.match(/status\/(\d+)/)?.[1] ?? `cell-${byKey.size + 1}`;
        const item: { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string } = {
          id,
          text: tweetText || fallbackText,
        };
        if (url) {
          item.url = url;
        }
        if (summary) {
          item.summary = summary;
          item.kind = classifySummary(summary);
        }
        if (tweetText) {
          item.tweetText = tweetText;
        }
        pushItem(item);
      }
    }

    return Array.from(byKey.values()).slice(0, maxItems);
  }, { op: "extract_notifications", maxItems: limit });
}

async function withEphemeralReadOnlyPage<T>(page: Page, url: string, run: (readPage: Page) => Promise<T>): Promise<T> {
  const context = page.context();
  const readPage = await context.newPage();
  try {
    await ensureNetworkCaptureInstalled(readPage);
    await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForTweetSurface(readPage);
    return await run(readPage);
  } finally {
    await readPage.close().catch(() => {});
  }
}

async function withEphemeralPage<T>(page: Page, url: string, run: (ephemeralPage: Page) => Promise<T>): Promise<T> {
  const context = page.context();
  const ephemeralPage = await context.newPage();
  try {
    await ensureNetworkCaptureInstalled(ephemeralPage);
    await ephemeralPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return await run(ephemeralPage);
  } finally {
    await ephemeralPage.close().catch(() => {});
  }
}

function getReadPageCacheState(page: Page): ReadPageCacheState {
  let state = READ_PAGE_CACHE.get(page);
  if (!state) {
    state = {
      pages: new Map<string, ReadPageCacheEntry>(),
      lru: [],
    };
    READ_PAGE_CACHE.set(page, state);
  }
  return state;
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

function touchReadPageLru(state: ReadPageCacheState, key: string): void {
  const next = state.lru.filter((item) => item !== key);
  next.push(key);
  state.lru = next;
}

async function evictReadPagesIfNeeded(state: ReadPageCacheState): Promise<void> {
  while (state.lru.length > MAX_READ_PAGE_CACHE_SIZE) {
    const evictKey = state.lru.shift();
    if (!evictKey) {
      return;
    }
    const entry = state.pages.get(evictKey);
    state.pages.delete(evictKey);
    if (entry && !entry.page.isClosed()) {
      await entry.page.close().catch(() => {});
    }
  }
}

async function getOrCreateCachedReadPage(ownerPage: Page, key: ReadPageKey, url: string): Promise<Page> {
  const state = getReadPageCacheState(ownerPage);
  const existing = state.pages.get(key);
  if (existing && !existing.page.isClosed()) {
    const currentUrl = existing.page.url();
    if (!isSameLocation(currentUrl, url)) {
      await existing.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForTweetSurface(existing.page);
    }
    touchReadPageLru(state, key);
    return existing.page;
  }

  const readPage = await ownerPage.context().newPage();
  await ensureNetworkCaptureInstalled(readPage);
  await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForTweetSurface(readPage);
  state.pages.set(key, { key, page: readPage });
  touchReadPageLru(state, key);
  await evictReadPagesIfNeeded(state);
  return readPage;
}

async function withCachedReadOnlyPage<T>(
  ownerPage: Page,
  key: ReadPageKey,
  url: string,
  run: (readPage: Page) => Promise<T>,
): Promise<T> {
  const readPage = await getOrCreateCachedReadPage(ownerPage, key, url);
  return await run(readPage);
}

async function closeCachedReadPages(ownerPage: Page): Promise<void> {
  const state = READ_PAGE_CACHE.get(ownerPage);
  READ_PAGE_CACHE.delete(ownerPage);
  if (!state) {
    return;
  }
  for (const entry of state.pages.values()) {
    if (!entry.page.isClosed()) {
      await entry.page.close().catch(() => {});
    }
  }
}

async function waitForTweetSurface(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const articleCount = document.querySelectorAll("article").length;
      const cellCount = document.querySelectorAll("[data-testid='cellInnerDiv']").length;
      const hasTweetText = document.querySelectorAll("[data-testid='tweetText'], div[lang], div[dir='auto']").length > 0;
      return articleCount > 0 || cellCount > 0 || hasTweetText;
    }, undefined, { timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(1_000);
}

function mapTweetCards(items: TweetCard[]): TimelineItem[] {
  return items.map((item) => {
    const mapped: TimelineItem = {
      id: item.id,
      text: item.text,
    };
    if (item.url) {
      mapped.url = item.url;
    }
    return mapped;
  });
}

function toTimelinePageFromNetwork(input: {
  items: TweetCard[];
  source: "network" | "dom";
  nextCursor?: string;
  reason?: string;
}): TimelinePage {
  const result: TimelinePage = {
    items: mapTweetCards(input.items),
    source: input.source,
    hasMore: false,
  };
  if (input.nextCursor) {
    result.nextCursor = input.nextCursor;
    result.hasMore = true;
  }
  if (input.source === "dom" && input.reason) {
    result.debug = { reason: input.reason };
  }
  return result;
}

async function readTimelineWithMode(
  page: Page,
  mode: Exclude<TimelineMode, "tweet">,
  limit: number,
  cursor?: string,
): Promise<TimelinePage> {
  await waitForTweetSurface(page);
  await warmupNetworkTemplate(page, mode);
  const networkRequest: { mode: Exclude<TimelineMode, "tweet">; limit: number; cursor?: string } = {
    mode,
    limit,
  };
  if (cursor) {
    networkRequest.cursor = cursor;
  }
  const fromNetwork = await readTimelineViaNetwork(page, networkRequest);
  if (fromNetwork.items.length > 0) {
    return toTimelinePageFromNetwork(fromNetwork);
  }
  const cards = await extractTweetCards(page, limit);
  return {
    items: mapTweetCards(cards),
    source: "dom",
    hasMore: false,
    debug: {
      reason: fromNetwork.reason ?? "dom_fallback",
    },
  };
}

function normalizeUsername(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/^@+/, "").trim();
}

function normalizeSearchMode(input: unknown): "top" | "latest" {
  return input === "top" ? "top" : "latest";
}

function buildSearchUrl(query: string, mode: "top" | "latest"): string {
  const url = new URL("https://x.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("src", "typed_query");
  url.searchParams.set("f", mode === "top" ? "top" : "live");
  return url.toString();
}

async function readTweetByUrl(page: Page, url: string): Promise<JsonValue> {
  return await withEphemeralReadOnlyPage(page, url, async (readPage) => {
    const matchId = url.match(/status\/(\d+)/)?.[1];
      if (matchId) {
        const fromNetwork = await readTimelineViaNetwork(readPage, {
          mode: "tweet",
          limit: 1,
          tweetId: matchId,
        });
        const first = fromNetwork.items[0];
        if (first) {
          return { tweet: first };
        }
      }
    const cards = await extractTweetCards(readPage, 1);
    const tweet = cards[0];
    if (!tweet) {
      return errorResult("UPSTREAM_CHANGED", "tweet content not found");
    }
    return { tweet };
  });
}

async function readTweetThreadByUrl(page: Page, url: string, limit: number): Promise<JsonValue> {
  return await withEphemeralReadOnlyPage(page, url, async (readPage) => {
    const matchId = url.match(/status\/(\d+)/)?.[1];
    const merged = new Map<string, TimelineItem>();
    let source: "network" | "dom" = "dom";

    const getThreadKey = (item: TimelineItem): string => {
      if (item.id && !item.id.startsWith("article-") && !item.id.startsWith("cell-")) {
        return `id:${item.id}`;
      }
      if (item.url) {
        const statusId = item.url.match(/status\/(\d+)/)?.[1];
        if (statusId) {
          return `id:${statusId}`;
        }
        return `url:${item.url}`;
      }
      return `text:${item.text}`;
    };

    const pickPreferredItem = (current: TimelineItem | undefined, next: TimelineItem): TimelineItem => {
      if (!current) {
        return next;
      }
      const currentScore = (current.url ? 10 : 0) + current.text.length;
      const nextScore = (next.url ? 10 : 0) + next.text.length;
      return nextScore > currentScore ? next : current;
    };

    const mergeItems = (items: TimelineItem[]): void => {
      for (const item of items) {
        const key = getThreadKey(item);
        merged.set(key, pickPreferredItem(merged.get(key), item));
      }
    };

    if (matchId) {
      const fromNetwork = await readTimelineViaNetwork(readPage, {
        mode: "tweet",
        limit,
        tweetId: matchId,
      });
      if (fromNetwork.items.length > 0) {
        mergeItems(mapTweetCards(fromNetwork.items));
        source = "network";
      }
    }

    const domCards = await extractTweetCards(readPage, Math.max(limit, 20));
    mergeItems(mapTweetCards(domCards));

    const tweets = Array.from(merged.values()).slice(0, limit);
    if (tweets.length === 0) {
      return errorResult("UPSTREAM_CHANGED", "tweet thread content not found");
    }
    return {
      tweets,
      source,
    };
  });
}

async function readNotifications(page: Page, limit: number): Promise<TimelinePage> {
  await waitForTweetSurface(page);
  const cards = await extractNotificationCards(page, limit);
  return {
    items: cards.map(enrichNotificationItem),
    source: "dom",
    hasMore: false,
    debug: {
      reason: "notifications_dom",
    },
  };
}

async function readProfile(page: Page, handle: string): Promise<JsonValue> {
  const normalizedHandle = handle.replace(/^@+/, "").trim();
  const profileUrl = `https://x.com/${normalizedHandle}`;
  return await withEphemeralReadOnlyPage(page, profileUrl, async (readPage) => {
    const profile = await readPage.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const name = document.querySelector<HTMLElement>("[data-testid='UserName'] span")?.textContent ?? "";
      const bio = document.querySelector<HTMLElement>("[data-testid='UserDescription']")?.textContent ?? "";
      const location = document.querySelector<HTMLElement>("[data-testid='UserLocation']")?.textContent ?? "";
      const website = document.querySelector<HTMLAnchorElement>("[data-testid='UserUrl'] a")?.href ?? "";
      const followingText = document.querySelector<HTMLAnchorElement>("a[href$='/following'] span")?.textContent ?? "";
      const followersText = document.querySelector<HTMLAnchorElement>("a[href$='/verified_followers'], a[href$='/followers'] span")
        ?.textContent ?? "";
      const output: {
        name: string;
        bio: string;
        location: string;
        website?: string;
        following: string;
        followers: string;
      } = {
        name: normalize(name),
        bio: normalize(bio),
        location: normalize(location),
        following: normalize(followingText),
        followers: normalize(followersText),
      };
      if (website) {
        output.website = website;
      }
      return output;
    });
    return {
      handle: `@${normalizedHandle}`,
      url: profileUrl,
      profile,
    };
  });
}

async function composePost(page: Page, text: string, dryRun: boolean): Promise<ComposeDomResult> {
  return await page.evaluate(
    ({ content, dryRunMode }) => {
      const pickFirst = (selectors: string[]): HTMLElement | null => {
        for (const selector of selectors) {
          const element = document.querySelector<HTMLElement>(selector);
          if (element) {
            return element;
          }
        }
        return null;
      };

      const clickFirst = (selectors: string[]): void => {
        const element = pickFirst(selectors);
        element?.click();
      };

      const setText = (target: HTMLElement, value: string): boolean => {
        target.focus();

        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          target.value = value;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }

        if (target.isContentEditable) {
          try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(target);
            selection?.removeAllRanges();
            selection?.addRange(range);
            document.execCommand("insertText", false, value);
          } catch {
            // Ignore and fallback to direct assignment below.
          }

          if ((target.textContent ?? "").trim() !== value) {
            target.textContent = value;
          }
          target.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
          return true;
        }

        return false;
      };

      const composerSelectors = [
        "div[data-testid='tweetTextarea_0']",
        "div[role='textbox'][data-testid='tweetTextarea_0']",
        "div[role='textbox'][aria-label*='Post text']",
        "div[role='textbox'][aria-label*='What is happening']",
      ];
      const openComposerSelectors = [
        "[data-testid='SideNav_NewTweet_Button']",
        "[data-testid='tweetButton']",
        "a[href='/compose/post']",
        "a[href='/compose/tweet']",
      ];
      const submitSelectors = [
        "[data-testid='tweetButtonInline']",
        "[data-testid='tweetButton']",
        "div[data-testid='toolBar'] [data-testid='tweetButtonInline']",
      ];

      let composer = pickFirst(composerSelectors);
      if (!composer) {
        clickFirst(openComposerSelectors);
        composer = pickFirst(composerSelectors);
      }
      if (!composer) {
        return { ok: false, reason: "composer_not_found" };
      }

      const inputOk = setText(composer, content);
      if (!inputOk) {
        return { ok: false, reason: "compose_input_failed" };
      }

      const submit = pickFirst(submitSelectors);
      if (dryRunMode) {
        return {
          ok: true,
          dryRun: true,
          submitVisible: submit !== null,
        };
      }

      if (!submit) {
        return { ok: false, reason: "submit_not_found" };
      }

      submit.click();
      return { ok: true };
    },
    { content: text, dryRunMode: dryRun },
  );
}

async function ensureComposerReady(page: Page): Promise<void> {
  const composerSelectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[role='textbox'][data-testid='tweetTextarea_0']",
    "div[role='textbox'][aria-label*='Post text']",
    "div[role='textbox'][aria-label*='What is happening']",
  ];
  const openComposerSelectors = [
    "[data-testid='SideNav_NewTweet_Button']",
    "[data-testid='tweetButton']",
    "a[href='/compose/post']",
    "a[href='/compose/tweet']",
  ];

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }

  await page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element) {
          element.click();
          return;
        }
      }
    }, openComposerSelectors)
    .catch(() => {});

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 2000 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }
}

async function waitForComposeConfirmation(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<{ confirmed: boolean; statusUrl?: string }> {
  const snippet = text.slice(0, 24).trim();
  if (!snippet) {
    return { confirmed: false };
  }

  try {
    await page.waitForFunction(
      (needle: string) => {
        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
        const normalizedNeedle = normalize(needle);
        const nodes = Array.from(document.querySelectorAll<HTMLElement>("article [data-testid='tweetText'], article div[lang]"));
        return nodes.some((node) => normalize(node.innerText || node.textContent || "").includes(normalizedNeedle));
      },
      snippet,
      { timeout: timeoutMs },
    );
  } catch {
    return { confirmed: false };
  }

  const statusUrl = await page.evaluate(({ needle }: { needle: string }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedNeedle = normalize(needle);
    const tweets = Array.from(document.querySelectorAll("article"));

    for (const tweet of tweets) {
      const textNodes = Array.from(tweet.querySelectorAll<HTMLElement>("[data-testid='tweetText'], div[lang]"));
      const matched = textNodes.some((node) =>
        normalize(node.innerText || node.textContent || "").includes(normalizedNeedle),
      );
      if (!matched) {
        continue;
      }
      const statusLink = tweet.querySelector<HTMLAnchorElement>("a[href*='/status/']");
      if (statusLink?.href) {
        return statusLink.href;
      }
    }
    return undefined;
  }, { needle: snippet });

  if (typeof statusUrl === "string" && statusUrl.length > 0) {
    return {
      confirmed: true,
      statusUrl,
    };
  }
  return { confirmed: true };
}

async function ensureReplyComposerReady(page: Page): Promise<void> {
  const composerSelectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[role='textbox'][data-testid='tweetTextarea_0']",
    "div[role='textbox'][aria-label*='Post text']",
    "div[role='textbox'][aria-label*='Reply']",
    "div[role='textbox'][aria-label*='Post your reply']",
  ];
  const openReplySelectors = [
    "[data-testid='reply']",
    "[data-testid='replyButton']",
    "button[aria-label*='Reply']",
    "div[role='button'][aria-label*='Reply']",
  ];

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }

  await page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element) {
          element.click();
          return;
        }
      }
    }, openReplySelectors)
    .catch(() => {});

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 2500 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }
}

async function composeReply(page: Page, text: string, dryRun: boolean): Promise<ReplyComposeDomResult> {
  const composerSelectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[role='textbox'][data-testid='tweetTextarea_0']",
    "div[role='textbox'][aria-label*='Reply']",
    "div[role='textbox'][aria-label*='Post your reply']",
    "div[role='textbox'][aria-label*='Post text']",
  ];
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

  let composerSelector: string | undefined;
  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
    if (!handle) {
      continue;
    }
    await handle.dispose().catch(() => {});
    composerSelector = selector;
    break;
  }

  if (!composerSelector) {
    return { ok: false, reason: "composer_not_found" };
  }

  try {
    await page.click(composerSelector);
    await page.keyboard.press(selectAllShortcut).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.type(composerSelector, text, { delay: 12 });
  } catch {
    return { ok: false, reason: "compose_input_failed" };
  }

  const submitVisible = await waitForReplySubmitReady(page, 2_000);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      submitVisible,
    };
  }

  if (!submitVisible) {
    return { ok: false, reason: "submit_not_found" };
  }

  return {
    ok: true,
    submitVisible: true,
  };
}

async function waitForReplySubmitReady(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      ({ op }) => {
        if (op !== "reply_submit_ready") {
          return false;
        }

        const selectors = [
          "[data-testid='tweetButtonInline']",
          "[data-testid='tweetButton']",
          "div[data-testid='toolBar'] [data-testid='tweetButtonInline']",
        ];

        const isEnabled = (element: HTMLElement | null): boolean => {
          if (!element) {
            return false;
          }
          if (element instanceof HTMLButtonElement) {
            return !element.disabled;
          }
          const ariaDisabled = (element.getAttribute("aria-disabled") ?? "").toLowerCase();
          return ariaDisabled !== "true";
        };

        const composerSelectors = [
          "div[data-testid='tweetTextarea_0']",
          "div[role='textbox'][data-testid='tweetTextarea_0']",
          "div[role='textbox'][aria-label*='Reply']",
          "div[role='textbox'][aria-label*='Post your reply']",
          "div[role='textbox'][aria-label*='Post text']",
        ];

        const findNearestSubmit = (composer: HTMLElement | null): HTMLElement | null => {
          if (!composer) {
            return null;
          }
          const roots = [
            composer.closest<HTMLElement>("[role='dialog']"),
            composer.closest<HTMLElement>("form"),
            composer.closest<HTMLElement>("article"),
            composer.parentElement,
            composer.parentElement?.parentElement,
            document.body,
          ];

          for (const root of roots) {
            if (!root) {
              continue;
            }
            for (const selector of selectors) {
              const element = root.querySelector<HTMLElement>(selector);
              if (isEnabled(element)) {
                return element;
              }
            }
          }
          return null;
        };

        let composer: HTMLElement | null = null;
        for (const selector of composerSelectors) {
          composer = document.querySelector<HTMLElement>(selector);
          if (composer) {
            break;
          }
        }

        if (findNearestSubmit(composer)) {
          return true;
        }

        for (const selector of selectors) {
          const element = document.querySelector<HTMLElement>(selector);
          if (isEnabled(element)) {
            return true;
          }
        }
        return false;
      },
      { op: "reply_submit_ready" },
      { timeout: Math.max(1_500, Math.min(timeoutMs, 6_000)) },
    );
    return true;
  } catch {
    return false;
  }
}

async function submitReply(page: Page): Promise<SubmitDomResult> {
  return await page.evaluate(({ op }) => {
    if (op !== "reply_submit") {
      return { ok: false, reason: "invalid_operation" };
    }

    const composerSelectors = [
      "div[data-testid='tweetTextarea_0']",
      "div[role='textbox'][data-testid='tweetTextarea_0']",
      "div[role='textbox'][aria-label*='Reply']",
      "div[role='textbox'][aria-label*='Post your reply']",
      "div[role='textbox'][aria-label*='Post text']",
    ];
    const selectors = [
      "[data-testid='tweetButtonInline']",
      "[data-testid='tweetButton']",
      "div[data-testid='toolBar'] [data-testid='tweetButtonInline']",
    ];

    const isEnabled = (element: HTMLElement | null): boolean => {
      if (!element) {
        return false;
      }
      if (element instanceof HTMLButtonElement) {
        return !element.disabled;
      }
      const ariaDisabled = (element.getAttribute("aria-disabled") ?? "").toLowerCase();
      return ariaDisabled !== "true";
    };

    const findNearestSubmit = (composer: HTMLElement | null): HTMLElement | null => {
      if (!composer) {
        return null;
      }
      const roots = [
        composer.closest<HTMLElement>("[role='dialog']"),
        composer.closest<HTMLElement>("form"),
        composer.closest<HTMLElement>("article"),
        composer.parentElement,
        composer.parentElement?.parentElement,
        document.body,
      ];

      for (const root of roots) {
        if (!root) {
          continue;
        }
        for (const selector of selectors) {
          const element = root.querySelector<HTMLElement>(selector);
          if (isEnabled(element)) {
            return element;
          }
        }
      }
      return null;
    };

    let composer: HTMLElement | null = null;
    for (const selector of composerSelectors) {
      composer = document.querySelector<HTMLElement>(selector);
      if (composer) {
        break;
      }
    }

    const nearestSubmit = findNearestSubmit(composer);
    if (nearestSubmit) {
      nearestSubmit.click();
      return { ok: true };
    }

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!isEnabled(element)) {
        continue;
      }
      element?.click();
      return { ok: true };
    }

    return { ok: false, reason: "submit_not_found" };
  }, { op: "reply_submit" });
}

async function waitForReplyConfirmation(
  page: Page,
  targetUrl: string,
  text: string,
  timeoutMs: number,
): Promise<{ confirmed: boolean; statusUrl?: string }> {
  const firstPassTimeoutMs = Math.max(2_500, Math.min(timeoutMs, 5_000));
  const firstPass = await waitForComposeConfirmation(page, text, firstPassTimeoutMs);
  if (firstPass.confirmed) {
    return firstPass;
  }

  await page.waitForTimeout(1_000);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForTweetSurface(page);

  const secondPassTimeoutMs = Math.max(2_500, timeoutMs - firstPassTimeoutMs);
  return await waitForComposeConfirmation(page, text, secondPassTimeoutMs);
}

async function waitForGrokSurface(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const composer =
        document.querySelector("textarea") ||
        document.querySelector("[contenteditable='true'][role='textbox']") ||
        document.querySelector("[role='textbox'][contenteditable='true']");
      const messages =
        document.querySelector("[data-message-author-role='assistant']") ||
        document.querySelector("[data-testid*='assistant']") ||
        document.querySelector("article");
      return composer !== null || messages !== null;
    }, undefined, { timeout: 12_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function submitGrokPrompt(page: Page, prompt: string): Promise<GrokComposeDomResult> {
  const composerSelectors = [
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[role='textbox'][contenteditable='true']",
  ];
  const submitSelectors = [
    "button[aria-label*='Grok something']",
    "button[aria-label*='Send']",
    "button[aria-label*='send']",
    "button[data-testid*='send']",
    "button[type='submit']",
  ];
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

  let composerSelector: string | undefined;
  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 1_200 }).catch(() => null);
    if (!handle) {
      continue;
    }
    await handle.dispose().catch(() => {});
    composerSelector = selector;
    break;
  }

  if (!composerSelector) {
    return { ok: false, reason: "composer_not_found" };
  }

  try {
    await page.click(composerSelector);
    await page.keyboard.press(selectAllShortcut).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.type(composerSelector, prompt, { delay: 12 });
  } catch {
    return { ok: false, reason: "compose_input_failed" };
  }

  const submitSelector = await page.evaluate((selectors) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        continue;
      }
      if (element instanceof HTMLButtonElement && element.disabled) {
        continue;
      }
      const ariaDisabled = (element.getAttribute("aria-disabled") ?? "").toLowerCase();
      if (ariaDisabled === "true") {
        continue;
      }
      const label = normalize(element.getAttribute("aria-label") ?? element.textContent ?? "");
      if (label.includes("stop")) {
        continue;
      }
      return selector;
    }
    return undefined;
  }, submitSelectors);

  if (!submitSelector) {
    return { ok: false, reason: "submit_not_found" };
  }

  try {
    await page.click(submitSelector);
  } catch {
    return { ok: false, reason: "submit_click_failed" };
  }

  return { ok: true };
}

async function prepareGrokSession(page: Page, conversationId?: string): Promise<void> {
  const targetUrl =
    typeof conversationId === "string" && conversationId.trim().length > 0
      ? `https://x.com/i/grok?conversation=${encodeURIComponent(conversationId.trim())}`
      : "https://x.com/i/grok";

  if (!isSameLocation(page.url(), targetUrl)) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  }

  await waitForGrokSurface(page);

  if (conversationId && conversationId.trim().length > 0) {
    return;
  }

  const currentConversationId = (() => {
    try {
      return new URL(page.url()).searchParams.get("conversation") ?? undefined;
    } catch {
      return undefined;
    }
  })();

  if (typeof (page as { locator?: unknown }).locator !== "function") {
    return;
  }

  const newChatButton = page
    .locator("button[aria-label*='New Chat'], button:has-text('New Chat')")
    .first();
  if ((await newChatButton.count().catch(() => 0)) === 0) {
    return;
  }

  await newChatButton.click({ timeout: 2_000 }).catch(() => {});
  await page
    .waitForFunction(
      ({ previousConversationId }) => {
        const currentUrl = window.location.href;
        try {
          const conversation = new URL(currentUrl).searchParams.get("conversation") ?? undefined;
          if (!previousConversationId) {
            return conversation === undefined || conversation.length === 0;
          }
          return conversation !== previousConversationId;
        } catch {
          return false;
        }
      },
      { previousConversationId: currentConversationId },
      { timeout: 5_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(600);
  await waitForGrokSurface(page);
}

async function askGrokViaNetwork(
  page: Page,
  prompt: string,
): Promise<{ ok: true; response: string; url: string; conversationId?: string } | undefined> {
  const captured = await captureRoutedResponseText(
    page,
    "https://grok.x.com/2/grok/add_response.json*",
    async () => {
      const submitResult = await submitGrokPrompt(page, prompt);
      return submitResult.ok;
    },
  );

  if (!captured || captured.status < 200 || captured.status >= 300) {
    return undefined;
  }

  const responseText = captured.text;
  const entries = parseNdjsonLines<{
    conversationId?: string;
    result?: {
      message?: string;
      messageTag?: string;
    };
  }>(responseText);
  const finalParts = collectTextByTag(
    entries.map((entry) => {
      const output: { message?: string; messageTag?: string } = {};
      if (typeof entry.result?.message === "string") {
        output.message = entry.result.message;
      }
      if (typeof entry.result?.messageTag === "string") {
        output.messageTag = entry.result.messageTag;
      }
      return output;
    }),
    "final",
  );
    let conversationId: string | undefined;
    for (const entry of entries) {
      if (!conversationId && typeof entry.conversationId === "string") {
        conversationId = entry.conversationId;
      }
    }

  const finalResponse = joinTextParts(finalParts).trim();
  if (!finalResponse) {
    return undefined;
  }

  const output: { ok: true; response: string; url: string; conversationId?: string } = {
    ok: true,
    response: finalResponse,
    url: typeof conversationId === "string" ? `https://x.com/i/grok?conversation=${conversationId}` : page.url(),
  };
  if (typeof conversationId === "string") {
    output.conversationId = conversationId;
  }
  return output;
}

async function waitForGrokResponse(
  page: Page,
  previousResponse: string | undefined,
  prompt: string,
  timeoutMs: number,
): Promise<{ confirmed: boolean; response?: string }> {
  try {
    await page.waitForFunction(
      ({ op, previous, promptText }) => {
        if (op !== "grok_wait") {
          return false;
        }

        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
        const previousText = normalize(previous);
        const normalizedPrompt = normalize(promptText);
        const isIgnoredResponse = (value: string): boolean => {
          const lower = value.toLowerCase();
          return (
            lower.length < 3 ||
            lower.startsWith("see new posts") ||
            lower.startsWith("thought for ") ||
            lower.startsWith("agents thinking") ||
            lower.startsWith("ask anything") ||
            lower === "agents" ||
            lower === "thinking" ||
            lower === "expert" ||
            lower.startsWith("grok") ||
            lower.includes("explore ") ||
            lower.includes("discuss ") ||
            lower.includes("create images") ||
            lower.includes("edit image") ||
            lower.includes("latest news") ||
            lower === normalizedPrompt.toLowerCase() ||
            lower === previousText.toLowerCase()
          );
        };
        const scope =
          document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
          document.querySelector<HTMLElement>("main");
        if (!scope) {
          return false;
        }
        const lines = (scope.innerText || scope.textContent || "")
          .split(/\n+/)
          .map((line) => normalize(line))
          .filter((line) => line.length > 0);
        const linePromptIndex = lines.lastIndexOf(normalizedPrompt);
        if (linePromptIndex >= 0) {
          const hasStopControl = Array.from(document.querySelectorAll<HTMLElement>("button")).some((button) => {
            const label = normalize(button.getAttribute("aria-label") ?? button.textContent ?? "").toLowerCase();
            return label.includes("stop");
          });
          let hasLineCandidate = false;
          for (let index = linePromptIndex + 1; index < lines.length; index += 1) {
            const candidate = lines[index];
            if (!candidate || isIgnoredResponse(candidate)) {
              continue;
            }
            hasLineCandidate = true;
          }
          if (!hasStopControl && hasLineCandidate) {
            return true;
          }
        }
        const entries: string[] = [];
        for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
          if (node.closest("button, a, textarea, nav")) {
            continue;
          }
          const text = normalize(node.innerText || node.textContent || "");
          if (!text) {
            continue;
          }
          const childWithSameText = Array.from(node.children).some((child) => {
            if (!(child instanceof HTMLElement)) {
              return false;
            }
            return normalize(child.innerText || child.textContent || "") === text;
          });
          if (childWithSameText) {
            continue;
          }
          if (entries[entries.length - 1] !== text) {
            entries.push(text);
          }
        }

        const hasStopControl = Array.from(document.querySelectorAll<HTMLElement>("button")).some((button) => {
          const label = normalize(button.getAttribute("aria-label") ?? button.textContent ?? "").toLowerCase();
          return label.includes("stop");
        });

        const promptIndex = entries.lastIndexOf(normalizedPrompt);
        if (promptIndex < 0) {
          return false;
        }

        let hasCandidate = false;
        for (let index = promptIndex + 1; index < entries.length; index += 1) {
          const candidate = entries[index];
          if (!candidate || isIgnoredResponse(candidate)) {
            continue;
          }
          hasCandidate = true;
        }

        return !hasStopControl && hasCandidate;
      },
      {
        op: "grok_wait",
        previous: (previousResponse ?? "").replace(/\s+/g, " ").trim(),
        promptText: prompt,
      },
      { timeout: timeoutMs },
    );
  } catch {
    return { confirmed: false };
  }

  const state = await page.evaluate(({ op, promptText, previousText }) => {
    if (op !== "grok_extract_state") {
      return undefined;
    }

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const normalizedPrompt = normalize(promptText);
    const normalizedPrevious = normalize(previousText);
    const isIgnoredResponse = (value: string): boolean => {
      const lower = value.toLowerCase();
      return (
        lower.length < 3 ||
        lower.startsWith("see new posts") ||
        lower.startsWith("thought for ") ||
        lower.startsWith("agents thinking") ||
        lower.startsWith("ask anything") ||
        lower === "agents" ||
        lower === "thinking" ||
        lower === "expert" ||
        lower.startsWith("grok") ||
        lower.includes("explore ") ||
        lower.includes("discuss ") ||
        lower.includes("create images") ||
        lower.includes("edit image") ||
        lower.includes("latest news") ||
        lower === normalizedPrompt.toLowerCase() ||
        lower === normalizedPrevious.toLowerCase()
      );
    };
    const scope =
      document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
      document.querySelector<HTMLElement>("main");
    if (!scope) {
      return undefined;
    }
    const lines = (scope.innerText || scope.textContent || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter((line) => line.length > 0);
    const lineResponseCandidates: string[] = [];
    const linePromptIndex = lines.lastIndexOf(normalizedPrompt);
    if (linePromptIndex >= 0) {
      for (let index = linePromptIndex + 1; index < lines.length; index += 1) {
        const candidate = lines[index];
        if (!candidate || isIgnoredResponse(candidate)) {
          continue;
        }
        lineResponseCandidates.push(candidate);
      }
    }
    let responseForPrompt: string | undefined;
    if (lineResponseCandidates.length > 0) {
      responseForPrompt = lineResponseCandidates.sort((left, right) => right.length - left.length)[0];
    }
    if (responseForPrompt) {
      let latestResponse = responseForPrompt;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const candidate = lines[index];
        if (!candidate || isIgnoredResponse(candidate)) {
          continue;
        }
        latestResponse = candidate;
        break;
      }
      return {
        responseForPrompt,
        latestResponse,
      };
    }

    const entries: string[] = [];
    for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
      if (node.closest("button, a, textarea, nav")) {
        continue;
      }
      const text = normalize(node.innerText || node.textContent || "");
      if (!text) {
        continue;
      }
      const childWithSameText = Array.from(node.children).some((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        return normalize(child.innerText || child.textContent || "") === text;
      });
      if (childWithSameText) {
        continue;
      }
      if (entries[entries.length - 1] !== text) {
        entries.push(text);
      }
    }

    const responseCandidates: string[] = [];
    const promptIndex = entries.lastIndexOf(normalizedPrompt);
    if (promptIndex >= 0) {
      for (let index = promptIndex + 1; index < entries.length; index += 1) {
        const candidate = entries[index];
        if (!candidate || isIgnoredResponse(candidate)) {
          continue;
        }
        responseCandidates.push(candidate);
      }
    }

    responseForPrompt = undefined;
    if (responseCandidates.length > 0) {
      responseForPrompt = responseCandidates.sort((left, right) => right.length - left.length)[0];
    }

    let latestResponse: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = entries[index];
      if (!candidate || isIgnoredResponse(candidate)) {
        continue;
      }
      latestResponse = candidate;
      break;
    }

    return {
      responseForPrompt,
      latestResponse,
    };
  }, {
    op: "grok_extract_state",
    promptText: prompt,
    previousText: previousResponse ?? "",
  });

  if (state && typeof state === "object" && typeof state.responseForPrompt === "string" && state.responseForPrompt.length > 0) {
    await page.waitForTimeout(600);
    const settledState = await page.evaluate(({ op, promptText, previousText }) => {
      if (op !== "grok_extract_state") {
        return undefined;
      }

      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const normalizedPrompt = normalize(promptText);
      const normalizedPrevious = normalize(previousText);
      const isIgnoredResponse = (value: string): boolean => {
        const lower = value.toLowerCase();
        return (
          lower.length < 3 ||
          lower.startsWith("see new posts") ||
          lower.startsWith("thought for ") ||
          lower.startsWith("agents thinking") ||
          lower.startsWith("ask anything") ||
          lower === "agents" ||
          lower === "thinking" ||
          lower === "expert" ||
          lower.startsWith("grok") ||
          lower.includes("explore ") ||
          lower.includes("discuss ") ||
          lower.includes("create images") ||
          lower.includes("edit image") ||
          lower.includes("latest news") ||
          lower === normalizedPrompt.toLowerCase() ||
          lower === normalizedPrevious.toLowerCase()
        );
      };
      const scope =
        document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
        document.querySelector<HTMLElement>("main");
      if (!scope) {
        return undefined;
      }
      const lines = (scope.innerText || scope.textContent || "")
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);
      const lineResponseCandidates: string[] = [];
      const linePromptIndex = lines.lastIndexOf(normalizedPrompt);
      if (linePromptIndex >= 0) {
        for (let index = linePromptIndex + 1; index < lines.length; index += 1) {
          const candidate = lines[index];
          if (!candidate || isIgnoredResponse(candidate)) {
            continue;
          }
          lineResponseCandidates.push(candidate);
        }
      }
      if (lineResponseCandidates.length > 0) {
        return {
          responseForPrompt: lineResponseCandidates.sort((left, right) => right.length - left.length)[0],
        };
      }

      const entries: string[] = [];
      for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
        if (node.closest("button, a, textarea, nav")) {
          continue;
        }
        const text = normalize(node.innerText || node.textContent || "");
        if (!text) {
          continue;
        }
        const childWithSameText = Array.from(node.children).some((child) => {
          if (!(child instanceof HTMLElement)) {
            return false;
          }
          return normalize(child.innerText || child.textContent || "") === text;
        });
        if (childWithSameText) {
          continue;
        }
        if (entries[entries.length - 1] !== text) {
          entries.push(text);
        }
      }

      const responseCandidates: string[] = [];
      const promptIndex = entries.lastIndexOf(normalizedPrompt);
      if (promptIndex >= 0) {
        for (let index = promptIndex + 1; index < entries.length; index += 1) {
          const candidate = entries[index];
          if (!candidate || isIgnoredResponse(candidate)) {
            continue;
          }
          responseCandidates.push(candidate);
        }
      }

      let responseForPrompt: string | undefined;
      if (responseCandidates.length > 0) {
        responseForPrompt = responseCandidates.sort((left, right) => right.length - left.length)[0];
      }

      return {
        responseForPrompt,
      };
    }, {
      op: "grok_extract_state",
      promptText: prompt,
      previousText: previousResponse ?? "",
    });

    if (
      settledState &&
      typeof settledState === "object" &&
      typeof settledState.responseForPrompt === "string" &&
      settledState.responseForPrompt.length > 0
    ) {
      return {
        confirmed: true,
        response: settledState.responseForPrompt,
      };
    }
  }

  if (state && typeof state === "object" && typeof state.responseForPrompt === "string" && state.responseForPrompt.length > 0) {
    return {
      confirmed: true,
      response: state.responseForPrompt,
    };
  }
  return { confirmed: false };
}

async function readLatestGrokResponse(page: Page): Promise<string | undefined> {
  const state = await page.evaluate(({ op }) => {
    if (op !== "grok_extract_state") {
      return undefined;
    }

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const isIgnoredResponse = (value: string): boolean => {
      const lower = value.toLowerCase();
      return (
        lower.length < 3 ||
        lower.startsWith("see new posts") ||
        lower.startsWith("thought for ") ||
        lower.startsWith("agents thinking") ||
        lower.startsWith("ask anything") ||
        lower === "agents" ||
        lower === "thinking" ||
        lower === "expert" ||
        lower.startsWith("grok") ||
        lower.includes("explore ")
      );
    };
    const scope =
      document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
      document.querySelector<HTMLElement>("main");
    if (!scope) {
      return undefined;
    }
    const lines = (scope.innerText || scope.textContent || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter((line) => line.length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!candidate || isIgnoredResponse(candidate)) {
        continue;
      }
      return { latestResponse: candidate };
    }

    const entries: string[] = [];
    for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
      if (node.closest("button, a, textarea, nav")) {
        continue;
      }
      const text = normalize(node.innerText || node.textContent || "");
      if (!text || isIgnoredResponse(text)) {
        continue;
      }
      const childWithSameText = Array.from(node.children).some((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        return normalize(child.innerText || child.textContent || "") === text;
      });
      if (childWithSameText) {
        continue;
      }
      if (entries[entries.length - 1] !== text) {
        entries.push(text);
      }
    }

    let latestResponse: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = entries[index];
      if (!candidate || isIgnoredResponse(candidate)) {
        continue;
      }
      latestResponse = candidate;
      break;
    }

    return { latestResponse };
  }, { op: "grok_extract_state" });

  if (state && typeof state === "object" && typeof state.latestResponse === "string") {
    return state.latestResponse;
  }
  return undefined;
}

function logGrokPhase(phase: string, details?: Record<string, JsonValue>): void {
  const payload: Record<string, JsonValue> = {
    phase,
  };
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) {
        payload[key] = value;
      }
    }
  }
  process.stderr.write(`[adapter-x grok] ${JSON.stringify(payload)}\n`);
}

async function askGrok(
  page: Page,
  prompt: string,
  timeoutMs: number,
  conversationId?: string,
): Promise<JsonValue> {
  logGrokPhase("start", { timeoutMs, promptLength: prompt.length });
  try {
    const targetUrl =
      typeof conversationId === "string" && conversationId.trim().length > 0
        ? `https://x.com/i/grok?conversation=${encodeURIComponent(conversationId.trim())}`
        : "https://x.com/i/grok";
    return await withEphemeralPage(page, targetUrl, async (grokPage) => {
      logGrokPhase("page_opened", { url: grokPage.url() });
      await prepareGrokSession(grokPage, conversationId);
      logGrokPhase("surface_ready");
      const networkResult = await askGrokViaNetwork(grokPage, prompt);
      logGrokPhase("network_result", {
        ok: networkResult?.ok === true,
        responseLength: networkResult?.response.length ?? 0,
      });
      if (networkResult?.ok) {
        const output: Record<string, JsonValue> = {
          ok: true,
          response: networkResult.response,
          url: networkResult.url,
        };
        if (networkResult.conversationId) {
          output.conversationId = networkResult.conversationId;
        }
        return output;
      }
      await grokPage.goto("https://x.com/i/grok", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await waitForGrokSurface(grokPage);
      const previousResponse = await readLatestGrokResponse(grokPage);
      logGrokPhase("previous_response_read", {
        hasPreviousResponse: previousResponse !== undefined,
        previousResponseLength: previousResponse?.length ?? 0,
      });
      const submitResult = await submitGrokPrompt(grokPage, prompt);
      const submitLogDetails: Record<string, JsonValue> = {
        ok: submitResult.ok,
      };
      if (submitResult.reason !== undefined) {
        submitLogDetails.reason = submitResult.reason;
      }
      logGrokPhase("submit_result", submitLogDetails);
      if (!submitResult.ok) {
        return errorResult("UPSTREAM_CHANGED", "grok controls not found", {
          reason: submitResult.reason ?? "unknown",
        });
      }

      logGrokPhase("wait_start", { timeoutMs });
      const confirmation = await waitForGrokResponse(grokPage, previousResponse, prompt, timeoutMs);
      logGrokPhase("wait_result", {
        confirmed: confirmation.confirmed,
        responseLength: confirmation.response?.length ?? 0,
      });
      if (!confirmation.confirmed || !confirmation.response) {
        return errorResult("ACTION_UNCONFIRMED", "grok response was not confirmed");
      }

      logGrokPhase("success", {
        responseLength: confirmation.response.length,
        url: grokPage.url(),
      });
      const output: Record<string, JsonValue> = {
        ok: true,
        response: confirmation.response,
        url: grokPage.url(),
      };
      if (conversationId) {
        output.conversationId = conversationId;
      }
      return output;
    });
  } catch (error) {
    const details: Record<string, JsonValue> = {};
    if (error instanceof Error) {
      details.name = error.name;
      details.message = error.message;
    } else if (error !== undefined) {
      details.message = String(error);
    }
    logGrokPhase("error", details);
    return errorResult("UPSTREAM_CHANGED", "grok execution threw", details);
  }
}

async function replyToTweet(
  page: Page,
  targetUrl: string,
  text: string,
  dryRun: boolean,
  timeoutMs: number,
): Promise<JsonValue> {
  return await withEphemeralPage(page, targetUrl, async (replyPage) => {
    await waitForTweetSurface(replyPage);
    await ensureReplyComposerReady(replyPage);
    const composeResult = await composeReply(replyPage, text, dryRun);
    if (!composeResult.ok) {
      return errorResult("UPSTREAM_CHANGED", "reply controls not found", {
        reason: composeResult.reason ?? "unknown",
      });
    }
    if (composeResult.dryRun) {
      return {
        ok: true,
        dryRun: true,
        submitVisible: composeResult.submitVisible === true,
        replyToUrl: targetUrl,
      };
    }

    const submitReady = await waitForReplySubmitReady(replyPage, timeoutMs);
    if (!submitReady) {
      return errorResult("UPSTREAM_CHANGED", "reply controls not ready", {
        reason: "submit_not_ready",
      });
    }

    const submitResult = await submitReply(replyPage);
    if (!submitResult.ok) {
      return errorResult("UPSTREAM_CHANGED", "reply controls not found", {
        reason: submitResult.reason ?? "unknown",
      });
    }

    const confirmation = await waitForReplyConfirmation(replyPage, targetUrl, text, timeoutMs);
    if (!confirmation.confirmed) {
      return errorResult("ACTION_UNCONFIRMED", "reply submit was not confirmed in timeline");
    }

    const result: Record<string, JsonValue> = {
      ok: true,
      confirmed: true,
      replyToUrl: targetUrl,
    };
    if (confirmation.statusUrl !== undefined) {
      result.statusUrl = confirmation.statusUrl;
    }
    return result;
  });
}

async function requireAuthenticated(page: Page): Promise<
  | {
      ok: true;
      auth: AuthProbeResult;
    }
  | {
      ok: false;
      result: JsonValue;
    }
> {
  const auth = await detectAuthStable(page);
  if (auth.state === "authenticated") {
    return { ok: true, auth };
  }
  if (auth.state === "challenge_required") {
    return {
      ok: false,
      result: errorResult("CHALLENGE_REQUIRED", "x.com challenge is blocking actions", {
        state: auth.state,
        signals: auth.signals,
      }),
    };
  }
  return {
    ok: false,
    result: errorResult("AUTH_REQUIRED", "login required", {
      state: auth.state,
      signals: auth.signals,
    }),
  };
}

export function createXAdapter(options?: CreateXAdapterOptions): SiteAdapter {
  const composeConfirmTimeoutMs = options?.composeConfirmTimeoutMs ?? DEFAULT_COMPOSE_CONFIRM_TIMEOUT_MS;
  const grokResponseTimeoutMs = options?.grokResponseTimeoutMs ?? DEFAULT_GROK_RESPONSE_TIMEOUT_MS;
  const maxPostLength = options?.maxPostLength ?? DEFAULT_MAX_POST_LENGTH;

  return {
    name: "adapter-x",
    start: async ({ page }) => {
      await ensureNetworkCaptureInstalled(page);
      await page.waitForLoadState("domcontentloaded").catch(() => {
        // Keep startup best-effort; auth probing will still run.
      });
      await warmupAuthProbe(page);
    },
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }, { page }) => {
      const args = toRecord(input);

      if (name === "auth.get") {
        const auth = await detectAuthStable(page);
        return {
          state: auth.state,
          signals: auth.signals,
        };
      }

      if (name === "timeline.home.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const result = cursor
          ? await readTimelineWithMode(page, "home", limit, cursor)
          : await readTimelineWithMode(page, "home", limit);
        if (result.source === "network" || result.items.length > 0) {
          return result;
        }
        return await withCachedReadOnlyPage(page, "home", "https://x.com/home", async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "home", limit, cursor)
            : await readTimelineWithMode(readPage, "home", limit);
        });
      }

      if (name === "tweet.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        return await readTweetByUrl(page, targetUrl);
      }

      if (name === "tweet.thread.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const limit = normalizeTimelineLimit(args);
        return await readTweetThreadByUrl(page, targetUrl, limit);
      }

      if (name === "favorites.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        return await withCachedReadOnlyPage(page, "bookmarks", "https://x.com/i/bookmarks", async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "bookmarks", limit, cursor)
            : await readTimelineWithMode(readPage, "bookmarks", limit);
        });
      }

      if (name === "notifications.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        return await withCachedReadOnlyPage(page, "notifications", "https://x.com/notifications", async (readPage) => {
          return await readNotifications(readPage, limit);
        });
      }

      if (name === "mentions.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        return await withCachedReadOnlyPage(
          page,
          "notifications:mentions",
          "https://x.com/notifications/mentions",
          async (readPage) => {
            return await readNotifications(readPage, limit);
          },
        );
      }

      if (name === "timeline.user.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const username = normalizeUsername(args.username);
        if (!username) {
          return errorResult("VALIDATION_ERROR", "username is required");
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const profileUrl = `https://x.com/${username}`;
        const cacheKey = `user:${username.toLowerCase()}`;
        return await withCachedReadOnlyPage(page, cacheKey, profileUrl, async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "user_timeline", limit, cursor)
            : await readTimelineWithMode(readPage, "user_timeline", limit);
        });
      }

      if (name === "search.tweets.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) {
          return errorResult("VALIDATION_ERROR", "query is required");
        }
        const mode = normalizeSearchMode(args.mode);
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const searchUrl = buildSearchUrl(query, mode);
        const cacheKey = `search:${mode}:${query.toLowerCase()}`;
        return await withCachedReadOnlyPage(page, cacheKey, searchUrl, async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "search", limit, cursor)
            : await readTimelineWithMode(readPage, "search", limit);
        });
      }

      if (name === "user.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const handle = typeof args.handle === "string" ? args.handle.trim() : "";
        if (!handle) {
          return errorResult("VALIDATION_ERROR", "handle is required");
        }
        return await readProfile(page, handle);
      }

      if (name === "tweet.create") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return errorResult("VALIDATION_ERROR", "text is required");
        }
        if (text.length > maxPostLength) {
          return errorResult("VALIDATION_ERROR", `text exceeds max length ${maxPostLength}`);
        }

        const dryRun = args.dryRun === true;
        await ensureComposerReady(page);
        const composeResult = await composePost(page, text, dryRun);
        if (!composeResult.ok) {
          return errorResult("UPSTREAM_CHANGED", "compose controls not found", {
            reason: composeResult.reason ?? "unknown",
          });
        }
        if (composeResult.dryRun) {
          return {
            ok: true,
            dryRun: true,
            submitVisible: composeResult.submitVisible === true,
          };
        }

        const confirmation = await waitForComposeConfirmation(page, text, composeConfirmTimeoutMs);
        if (!confirmation.confirmed) {
          return errorResult("ACTION_UNCONFIRMED", "post submit was not confirmed in timeline");
        }

        const result: Record<string, JsonValue> = {
          ok: true,
          confirmed: true,
        };
        if (confirmation.statusUrl !== undefined) {
          result.statusUrl = confirmation.statusUrl;
        }
        return result;
      }

      if (name === "tweet.reply") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return errorResult("VALIDATION_ERROR", "text is required");
        }
        if (text.length > maxPostLength) {
          return errorResult("VALIDATION_ERROR", `text exceeds max length ${maxPostLength}`);
        }

        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }

        const dryRun = args.dryRun === true;
        return await replyToTweet(page, targetUrl, text, dryRun, composeConfirmTimeoutMs);
      }

      if (name === "grok.chat") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          return errorResult("VALIDATION_ERROR", "prompt is required");
        }

        const conversationId = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
        return await askGrok(page, prompt, grokResponseTimeoutMs, conversationId || undefined);
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
    stop: async ({ page }) => {
      await closeCachedReadPages(page);
    },
  };
}
