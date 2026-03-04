/**
 * This module implements the X site fallback adapter with robust auth checks and compose confirmation.
 * It depends on Playwright page evaluation and shared adapter contracts to execute browser-side tool actions.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { SiteAdapter, WebMcpToolDefinition } from "@webmcp-bridge/playwright";
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

export type CreateXAdapterOptions = {
  composeConfirmTimeoutMs?: number;
  maxPostLength?: number;
};

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 20;
const DEFAULT_COMPOSE_CONFIRM_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_POST_LENGTH = 280;
const AUTH_STABILIZE_ATTEMPTS = 6;
const AUTH_STABILIZE_DELAY_MS = 750;
const AUTH_WARMUP_TIMEOUT_MS = 12_000;

const CAPTURE_INJECT_SCRIPT = String.raw`
(() => {
  const globalAny = window;
  if (globalAny.__WEBMCP_X_CAPTURE__) {
    return;
  }

  const state = {
    enabled: true,
    entries: [],
  };

  const now = () => Date.now();
  const isGraphQLTimelineUrl = (url) => {
    if (typeof url !== "string") return false;
    return (
      url.includes("/i/api/graphql/") &&
      (url.includes("/HomeTimeline") || url.includes("/Bookmarks") || url.includes("/BookmarksAll") || url.includes("/TweetDetail"))
    );
  };

  const detectOperation = (url) => {
    if (url.includes("/HomeTimeline")) return "HomeTimeline";
    if (url.includes("/BookmarksAll")) return "BookmarksAll";
    if (url.includes("/Bookmarks")) return "Bookmarks";
    if (url.includes("/TweetDetail")) return "TweetDetail";
    return "Unknown";
  };

  const pickHeaders = (headersLike) => {
    const output = {};
    if (!headersLike) return output;
    try {
      const headers = new Headers(headersLike);
      headers.forEach((value, key) => {
        output[String(key).toLowerCase()] = String(value);
      });
      return output;
    } catch {
      if (typeof headersLike === "object") {
        for (const [k, v] of Object.entries(headersLike)) {
          output[String(k).toLowerCase()] = String(v);
        }
      }
      return output;
    }
  };

  const appendEntry = (entry) => {
    state.entries.push(entry);
    if (state.entries.length > 80) {
      state.entries.splice(0, state.entries.length - 80);
    }
  };

  const originalFetch = globalAny.fetch?.bind(globalAny);
  if (typeof originalFetch === "function") {
    globalAny.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url || "";
      const method = String(init.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
      const headers = pickHeaders(init.headers || (typeof input !== "string" ? input?.headers : undefined));
      const body = typeof init.body === "string" ? init.body : undefined;
      const shouldCapture = isGraphQLTimelineUrl(url);
      const response = await originalFetch(...args);

      if (shouldCapture) {
        let responseJson;
        try {
          responseJson = await response.clone().json();
        } catch {
          responseJson = undefined;
        }
        appendEntry({
          ts: now(),
          op: detectOperation(url),
          url,
          method,
          headers,
          body,
          ok: response.ok,
          status: response.status,
          responseJson,
        });
      }
      return response;
    };
  }

  const OriginalXMLHttpRequest = globalAny.XMLHttpRequest;
  const xhrProto = OriginalXMLHttpRequest?.prototype;
  if (xhrProto && !xhrProto.__webmcpCapturePatched) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    const originalSetRequestHeader = xhrProto.setRequestHeader;

    xhrProto.open = function(method, url, ...rest) {
      this.__webmcpCapture = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        headers: {},
      };
      return originalOpen.call(this, method, url, ...rest);
    };

    xhrProto.setRequestHeader = function(key, value) {
      try {
        const capture = this.__webmcpCapture;
        if (capture && capture.headers && typeof key === "string") {
          capture.headers[String(key).toLowerCase()] = String(value);
        }
      } catch {}
      return originalSetRequestHeader.call(this, key, value);
    };

    xhrProto.send = function(body) {
      try {
        this.addEventListener("loadend", () => {
          const capture = this.__webmcpCapture || {};
          const url = typeof capture.url === "string" ? capture.url : "";
          if (!isGraphQLTimelineUrl(url)) {
            return;
          }
          let responseJson;
          try {
            const text = typeof this.responseText === "string" ? this.responseText : "";
            responseJson = text ? JSON.parse(text) : undefined;
          } catch {
            responseJson = undefined;
          }
          appendEntry({
            ts: now(),
            op: detectOperation(url),
            url,
            method: typeof capture.method === "string" ? capture.method : "GET",
            headers: capture.headers || {},
            body: typeof body === "string" ? body : undefined,
            ok: this.status >= 200 && this.status < 300,
            status: Number(this.status || 0),
            responseJson,
          });
        });
      } catch {}
      return originalSend.call(this, body);
    };

    xhrProto.__webmcpCapturePatched = true;
  }

  globalAny.__WEBMCP_X_CAPTURE__ = state;
})();
`;

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "auth.get",
    description: "Detect login/challenge state",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "timeline.list",
    description: "Read timeline tweet cards",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: { type: "string" },
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
      properties: {
        url: { type: "string" },
        id: { type: "string" },
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
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: { type: "string" },
      },
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
      properties: {
        handle: { type: "string", minLength: 1 },
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
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: DEFAULT_MAX_POST_LENGTH,
        },
        dryRun: {
          type: "boolean",
        },
      },
      required: ["text"],
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

async function hasCapturedTemplate(page: Page, mode: "home" | "bookmarks" | "tweet"): Promise<boolean> {
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
          : ["TweetDetail"];
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

async function warmupNetworkTemplate(page: Page, mode: "home" | "bookmarks"): Promise<void> {
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

type TimelinePage = {
  items: TweetCard[];
  source: "network" | "dom";
  hasMore: boolean;
  nextCursor?: string;
  debug?: {
    reason: string;
  };
};

type ReadPageKind = "home" | "bookmarks";
type TimelineMode = "home" | "bookmarks" | "tweet";
type NetworkTemplate = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const READ_PAGE_CACHE = new WeakMap<Page, Map<ReadPageKind, Page>>();
const PROCESS_TEMPLATE_CACHE = new Map<TimelineMode, NetworkTemplate>();

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
              : ["TweetDetail"];

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

      const sanitizeHeaders = (headers: Record<string, string>): Record<string, string> => {
        const blockedPrefixes = ["sec-", ":"];
        const blockedExact = new Set(["host", "content-length", "cookie", "origin", "referer", "connection"]);
        const output: Record<string, string> = {};
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
        selectedTemplate?: {
          url: string;
          method: string;
          headers: Record<string, string>;
          body?: string;
        };
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
    typeof selectedTemplate.method === "string" &&
    typeof selectedTemplate.headers === "object" &&
    selectedTemplate.headers !== null &&
    !Array.isArray(selectedTemplate.headers)
  ) {
    const cacheValue: NetworkTemplate = {
      url: selectedTemplate.url,
      method: selectedTemplate.method,
      headers: selectedTemplate.headers as Record<string, string>,
    };
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

function getReadPageMap(page: Page): Map<ReadPageKind, Page> {
  let map = READ_PAGE_CACHE.get(page);
  if (!map) {
    map = new Map<ReadPageKind, Page>();
    READ_PAGE_CACHE.set(page, map);
  }
  return map;
}

function isSamePath(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
}

async function getOrCreateCachedReadPage(ownerPage: Page, kind: ReadPageKind, url: string): Promise<Page> {
  const map = getReadPageMap(ownerPage);
  const existing = map.get(kind);
  if (existing && !existing.isClosed()) {
    const currentUrl = existing.url();
    if (!isSamePath(currentUrl, url)) {
      await existing.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForTweetSurface(existing);
    }
    return existing;
  }

  const readPage = await ownerPage.context().newPage();
  await ensureNetworkCaptureInstalled(readPage);
  await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForTweetSurface(readPage);
  map.set(kind, readPage);
  return readPage;
}

async function withCachedReadOnlyPage<T>(
  ownerPage: Page,
  kind: ReadPageKind,
  url: string,
  run: (readPage: Page) => Promise<T>,
): Promise<T> {
  const readPage = await getOrCreateCachedReadPage(ownerPage, kind, url);
  return await run(readPage);
}

async function closeCachedReadPages(ownerPage: Page): Promise<void> {
  const map = READ_PAGE_CACHE.get(ownerPage);
  READ_PAGE_CACHE.delete(ownerPage);
  if (!map) {
    return;
  }
  for (const readPage of map.values()) {
    if (!readPage.isClosed()) {
      await readPage.close().catch(() => {});
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

async function readTimeline(
  page: Page,
  limit: number,
  cursor?: string,
): Promise<TimelinePage> {
  await waitForTweetSurface(page);
  await warmupNetworkTemplate(page, "home");
  const networkRequest: { mode: "home"; limit: number; cursor?: string } = {
    mode: "home",
    limit,
  };
  if (cursor) {
    networkRequest.cursor = cursor;
  }
  const fromNetwork = await readTimelineViaNetwork(page, networkRequest);
  if (fromNetwork.items.length > 0) {
    const items = fromNetwork.items.map((item) => {
      const mapped: { id: string; text: string; url?: string } = {
        id: item.id,
        text: item.text,
      };
      if (item.url) {
        mapped.url = item.url;
      }
      return mapped;
    });
    const result: TimelinePage = {
      items,
      source: fromNetwork.source,
      hasMore: false,
    };
    if (fromNetwork.nextCursor) {
      result.nextCursor = fromNetwork.nextCursor;
      result.hasMore = true;
    }
    if (fromNetwork.source === "dom" && fromNetwork.reason) {
      result.debug = { reason: fromNetwork.reason };
    }
    return result;
  }
  const fromReadOnly = await withCachedReadOnlyPage(page, "home", "https://x.com/home", async (readPage) => {
    const readOnlyRequest: { mode: "home"; limit: number; cursor?: string } = {
      mode: "home",
      limit,
    };
    if (cursor) {
      readOnlyRequest.cursor = cursor;
    }
    const network = await readTimelineViaNetwork(readPage, readOnlyRequest);
    return network;
  });
  if (fromReadOnly.items.length > 0) {
    const items = fromReadOnly.items.map((item) => {
      const mapped: { id: string; text: string; url?: string } = {
        id: item.id,
        text: item.text,
      };
      if (item.url) {
        mapped.url = item.url;
      }
      return mapped;
    });
    const result: TimelinePage = {
      items,
      source: fromReadOnly.source,
      hasMore: false,
    };
    if (fromReadOnly.nextCursor) {
      result.nextCursor = fromReadOnly.nextCursor;
      result.hasMore = true;
    }
    if (fromReadOnly.source === "dom" && fromReadOnly.reason) {
      result.debug = { reason: fromReadOnly.reason };
    }
    return result;
  }
  const cards = await extractTweetCards(page, limit);
  const items = cards.map((card) => {
    const item: { id: string; text: string; url?: string } = {
      id: card.id,
      text: card.text,
    };
    if (card.url) {
      item.url = card.url;
    }
    return item;
  });
  return {
    items,
    source: "dom",
    hasMore: false,
    debug: {
      reason: fromReadOnly.reason ?? fromNetwork.reason ?? "dom_fallback",
    },
  };
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

      if (name === "timeline.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const result = cursor ? await readTimeline(page, limit, cursor) : await readTimeline(page, limit);
        return result;
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

      if (name === "favorites.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        return await withCachedReadOnlyPage(page, "bookmarks", "https://x.com/i/bookmarks", async (readPage) => {
          await waitForTweetSurface(readPage);
          await warmupNetworkTemplate(readPage, "bookmarks");
          const bookmarksRequest: { mode: "bookmarks"; limit: number; cursor?: string } = {
            mode: "bookmarks",
            limit,
          };
          if (cursor) {
            bookmarksRequest.cursor = cursor;
          }
          const network = await readTimelineViaNetwork(readPage, bookmarksRequest);
          if (network.items.length > 0) {
            const items = network.items.map((item) => {
              const mapped: { id: string; text: string; url?: string } = {
                id: item.id,
                text: item.text,
              };
              if (item.url) {
                mapped.url = item.url;
              }
              return mapped;
            });
            const result: {
              items: Array<{ id: string; text: string; url?: string }>;
              source: "network" | "dom";
              hasMore: boolean;
              nextCursor?: string;
              debug?: {
                reason: string;
              };
            } = {
              items,
              source: network.source,
              hasMore: false,
            };
            if (network.nextCursor) {
              result.nextCursor = network.nextCursor;
              result.hasMore = true;
            }
            if (network.source === "dom" && network.reason) {
              result.debug = { reason: network.reason };
            }
            return result;
          }

          return await readTimeline(readPage, limit, cursor || undefined);
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

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
    stop: async ({ page }) => {
      await closeCachedReadPages(page);
    },
  };
}
