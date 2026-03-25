/**
 * This module implements the Google fallback adapter for Google Search and Gemini flows.
 * It depends on browser-side page automation and shared adapter contracts so local-mcp can execute privileged Google actions inside the user's signed-in browser session.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type {
  AdapterManifest,
  SiteAdapter,
  WebMcpToolDefinition,
} from "@webmcp-bridge/playwright";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const GEMINI_URL = "https://gemini.google.com/app";
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_GEMINI_TIMEOUT_MS = 90_000;
const MAX_GEMINI_TIMEOUT_MS = 600_000;
const GEMINI_ARTIFACT_DIR_PREFIX = "webmcp-bridge-gemini-";

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "auth.get",
    description: "Detect whether the current Google session still needs interactive sign-in",
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
    name: "search.web",
    description: "Run a Google web search and return visible result cards",
    inputSchema: {
      type: "object",
      description: "Search the public Google results page.",
      properties: {
        query: {
          type: "string",
          description: "Search query text.",
        },
        limit: {
          type: "integer",
          description: `Maximum number of result items to return. Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
        hl: {
          type: "string",
          description: "Optional Google UI language, for example en or ja.",
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
    name: "gemini.chat",
    description: "Send a Gemini prompt for text or image generation and optionally download generated images",
    inputSchema: {
      type: "object",
      description: "Runs inside the logged-in Gemini browser session.",
      properties: {
        prompt: {
          type: "string",
          description: "Prompt text to send to Gemini.",
        },
        mode: {
          type: "string",
          description: "Gemini response mode. text is default; image toggles the Create image tool before sending.",
          enum: ["text", "image"],
        },
        timeoutMs: {
          type: "integer",
          description: `Maximum wait for the Gemini response. Default ${DEFAULT_GEMINI_TIMEOUT_MS}ms, max ${MAX_GEMINI_TIMEOUT_MS}ms.`,
          minimum: 1_000,
          maximum: MAX_GEMINI_TIMEOUT_MS,
        },
        downloadImages: {
          type: "boolean",
          description: "When mode=image, download any generated images to local temporary files. Defaults to true for image mode.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "gemini.image.download",
    description: "Download generated Gemini images from the current or target conversation",
    inputSchema: {
      type: "object",
      description: "Downloads visible generated images using Gemini's built-in download buttons.",
      properties: {
        conversationUrl: {
          type: "string",
          description: "Optional Gemini conversation URL. If omitted, use the current page.",
        },
        limit: {
          type: "integer",
          description: "Optional maximum number of images to download.",
          minimum: 1,
          maximum: 8,
        },
        timeoutMs: {
          type: "integer",
          description: `Maximum wait for visible download buttons. Default ${DEFAULT_GEMINI_TIMEOUT_MS}ms, max ${MAX_GEMINI_TIMEOUT_MS}ms.`,
          minimum: 1_000,
          maximum: MAX_GEMINI_TIMEOUT_MS,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "page.navigate",
    description: "Navigate the current browser page to a Google-owned URL",
    inputSchema: {
      type: "object",
      description: "Navigate within google.com hosts only.",
      properties: {
        url: {
          type: "string",
          description: "Absolute Google URL, for example https://www.google.com/ or https://gemini.google.com/.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "page.inspect",
    description: "Inspect interactive elements on the current page for adapter development",
    inputSchema: {
      type: "object",
      description: "Return a compact snapshot of visible form controls and actions.",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector to scope the inspection.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of elements per category. Default 20.",
          minimum: 1,
          maximum: 100,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
];

type GoogleAuthState = "authenticated" | "auth_required";
type GeminiMode = "text" | "image";
type GeminiWaitResult =
  | {
      status: "ready";
      responseText?: string | null;
      imageCount?: number;
    }
  | {
      status: "pending";
      active?: boolean;
      fingerprint?: string;
      responseText?: string | null;
      imageCount?: number;
    }
  | { status: "error"; message: string };

type GeminiWaitProbeResult =
  | {
      status: "probe";
      active: boolean;
      fingerprint: string;
      responseText?: string | null;
      responseCount?: number;
      imageCount?: number;
      hasResponseFeedback?: boolean;
      hasStructuredResponse?: boolean;
      hasDownloadButton?: boolean;
    }
  | { status: "error"; message: string };

type GeminiImageModeSelection =
  | { status: "selected" | "already_selected" | "not_needed" }
  | {
      status: "unsupported";
      currentMode?: string;
      availableModes?: string[];
    };

type GooglePage = {
  evaluate: <T, Arg = void>(pageFunction: (arg: Arg) => T | Promise<T>, arg?: Arg) => Promise<T>;
  goto: (url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  waitForTimeout: (timeout: number) => Promise<void>;
  locator: (selector: string) => {
    first: () => unknown;
    count: () => Promise<number>;
  };
  getByRole: (
    role: string,
    options?: { name?: string | RegExp },
  ) => {
    first: () => unknown;
  };
  waitForEvent: (event: string, options?: { timeout?: number }) => Promise<unknown>;
};

type GeminiImageArtifact = {
  kind: "file";
  name: string;
  path: string;
  mimeType?: string;
  imageIndex: number;
};

function errorResult(code: string, message: string, details?: Record<string, JsonValue>): JsonValue {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function toRecord(value: JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeGeminiComparableText(value: string | null | undefined): string {
  return normalizeText(value ?? "").toLowerCase();
}

function shouldTreatGeminiTextResponseAsReady(
  probe: Extract<GeminiWaitProbeResult, { status: "probe" }>,
  previousSnapshot?: {
    responseText?: string | null;
    responseCount?: number;
  },
): boolean {
  if (probe.active || !probe.responseText) {
    return false;
  }

  return (
    Boolean(probe.hasResponseFeedback || probe.hasStructuredResponse) &&
    (
      normalizeGeminiComparableText(probe.responseText) !==
        normalizeGeminiComparableText(previousSnapshot?.responseText) ||
      (probe.responseCount ?? 0) > (previousSnapshot?.responseCount ?? 0)
    )
  );
}

function isGoogleOwnedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "google.com" || host.endsWith(".google.com"));
  } catch {
    return false;
  }
}

function isGeminiConversationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "gemini.google.com" && parsed.pathname.startsWith("/app");
  } catch {
    return false;
  }
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const integer = Math.trunc(value);
  return Math.min(max, Math.max(min, integer));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function detectGoogleAuthState(page: {
  url: () => string;
  title: () => Promise<string>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}): Promise<{
  state: GoogleAuthState;
  url: string;
  title: string;
  signals: string[];
}> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const signals: string[] = [];

  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    hostname = "";
  }

  if (hostname === "accounts.google.com") {
    signals.push("accounts-host");
  }

  const pageSignals = await page
    .evaluate(() => {
      const bodyText = document.body?.innerText?.toLowerCase() ?? "";
      const titleText = document.title?.toLowerCase() ?? "";
      const href = window.location.href;
      return {
        hasSignInText:
          bodyText.includes("sign in") ||
          bodyText.includes("choose an account") ||
          bodyText.includes("use your google account"),
        hasGeminiMarker:
          bodyText.includes("gemini") ||
          titleText.includes("gemini") ||
          href.includes("gemini.google.com"),
        hasGoogleAccountMarker:
          bodyText.includes("google account") ||
          href.includes("myaccount.google.com"),
      };
    })
    .catch(() => ({
      hasSignInText: false,
      hasGeminiMarker: false,
      hasGoogleAccountMarker: false,
    }));

  if (pageSignals.hasSignInText) {
    signals.push("signin-text");
  }
  if (pageSignals.hasGeminiMarker) {
    signals.push("gemini-marker");
  }
  if (pageSignals.hasGoogleAccountMarker) {
    signals.push("account-marker");
  }

  const state: GoogleAuthState =
    signals.includes("accounts-host") || signals.includes("signin-text")
      ? "auth_required"
      : "authenticated";

  return {
    state,
    url,
    title,
    signals,
  };
}

async function inspectPage(page: GooglePage, selector: string | undefined, limit: number): Promise<JsonValue> {
  const scopedSelector = selector?.trim() ? selector.trim() : "";
  return await page.evaluate(
    ({ scopedSelector: scope, limit: itemLimit }: { scopedSelector: string; limit: number }) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const root = scope ? document.querySelector(scope) : document.body;
      if (!root) {
        return {
          error: {
            code: "SELECTOR_NOT_FOUND",
            message: `selector not found: ${scope}`,
          },
        };
      }

      const visible = (element: Element): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const summarize = (element: Element) => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: normalize(node.innerText || node.textContent || ""),
          ariaLabel: normalize(node.getAttribute("aria-label") || ""),
          role: normalize(node.getAttribute("role") || ""),
          type: normalize(node.getAttribute("type") || ""),
          name: normalize(node.getAttribute("name") || ""),
          id: normalize(node.id || ""),
          placeholder: normalize(node.getAttribute("placeholder") || ""),
          href: normalize(node.getAttribute("href") || ""),
          testId: normalize(node.getAttribute("data-test-id") || node.getAttribute("data-testid") || ""),
          classes: normalize(node.className || ""),
          contentEditable: node.getAttribute("contenteditable") || "",
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      };

      const collect = (query: string) =>
        Array.from(root.querySelectorAll<Element>(query))
          .filter(visible)
          .slice(0, itemLimit)
          .map(summarize);

      const textSnippets = Array.from(root.querySelectorAll<Element>("h1, h2, h3, p, div, span"))
        .filter(visible)
        .map((element) => normalize((element as HTMLElement).innerText || element.textContent || ""))
        .filter((value, index, values) => value.length > 0 && value.length <= 200 && values.indexOf(value) === index)
        .slice(0, itemLimit);

      return {
        url: window.location.href,
        title: document.title,
        scope: scope || "body",
        editable: collect("textarea, input, [contenteditable=''], [contenteditable='true'], [role='textbox']"),
        buttons: collect("button, [role='button']"),
        links: collect("a[href]"),
        images: collect("img"),
        textSnippets,
      };
    },
    {
      scopedSelector,
      limit,
    },
  );
}

async function ensureGeminiPage(page: GooglePage): Promise<void> {
  if (page.url().startsWith(GEMINI_URL) || isGeminiConversationUrl(page.url())) {
    return;
  }
  await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

async function requireGeminiAuthentication(page: GooglePage): Promise<JsonValue | undefined> {
  await ensureGeminiPage(page);
  const auth = await detectGoogleAuthState(page);
  if (auth.state === "authenticated") {
    return undefined;
  }
  return errorResult("AUTH_REQUIRED", "login required", {
    state: auth.state,
    url: auth.url,
    signals: auth.signals,
  });
}

async function runGoogleSearch(page: GooglePage, query: string, limit: number, hl: string): Promise<JsonValue> {
  const targetUrl = `${GOOGLE_SEARCH_URL}?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(hl)}`;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);

  const result = await page.evaluate(
    ({ limit: maxItems }) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const normalizeLines = (value: string): string[] =>
        value
          .split(/\n+/)
          .map((item) => normalize(item))
          .filter((item) => item.length > 0);
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const isExternalResultUrl = (value: string): boolean => {
        try {
          const parsed = new URL(value, window.location.href);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return false;
          }
          const host = parsed.hostname.toLowerCase();
          return host !== "google.com" && !host.endsWith(".google.com");
        } catch {
          return false;
        }
      };

      const items: Array<{
        title: string;
        url: string;
        snippet: string;
        displayText: string;
      }> = [];

      const root = document.querySelector("#search") ?? document.body;
      for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
        if (!visible(anchor)) {
          continue;
        }
        const url = anchor.href;
        if (!isExternalResultUrl(url)) {
          continue;
        }
        const heading = anchor.querySelector("h3");
        const rawText = anchor.innerText || anchor.textContent || "";
        const lines = normalizeLines(rawText);
        const title =
          normalize(heading?.innerText || heading?.textContent || "") ||
          lines.find((line) => line.length > 0 && !line.startsWith("http")) ||
          "";
        const text = normalize(rawText);
        const displayText = title || text;
        if (!displayText) {
          continue;
        }

        const container =
          anchor.closest("div[data-snc], div.g, div.Gx5Zad, div.MjjYud, div[data-hveid], div.Ww4FFb") ??
          anchor.parentElement;
        const containerText = normalize(
          ((container as HTMLElement | null)?.innerText || container?.textContent || ""),
        );
        const snippet = normalize(containerText.replace(text, "").replace(displayText, ""));
        if (items.some((entry) => entry.url === url)) {
          continue;
        }

        items.push({
          title: displayText,
          url,
          snippet,
          displayText: text,
        });

        if (items.length >= maxItems) {
          break;
        }
      }

      return {
        url: window.location.href,
        title: document.title,
        query:
          normalize(
            (document.querySelector("textarea[name='q'], textarea[aria-label='Search'], input[name='q']") as
              | HTMLTextAreaElement
              | HTMLInputElement
              | null)?.value || "",
          ) || new URL(window.location.href).searchParams.get("q") || "",
        items,
      };
    },
    { limit },
  );

  return {
    ...result,
    source: "dom",
  };
}

async function ensureGeminiImageMode(page: GooglePage, mode: GeminiMode): Promise<void> {
  const livePage = page as unknown as {
    locator: (selector: string) => { count: () => Promise<number>; first: () => { click: () => Promise<void> } };
    waitForTimeout: (timeout: number) => Promise<void>;
  };

  const deselectButtonCount = await livePage
    .locator("button[aria-label*='Deselect Create image']")
    .count()
    .catch(() => 0);

  if (mode === "image") {
    if (deselectButtonCount > 0) {
      return;
    }
    return;
  }

  if (deselectButtonCount > 0) {
    await livePage.locator("button[aria-label*='Deselect Create image']").first().click();
    await livePage.waitForTimeout(600);
  }
}

async function dismissGeminiBlockingPopup(page: GooglePage): Promise<boolean> {
  const dismissed = await page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const click = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      element.click();
      return true;
    };

    const actions = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"))
      .filter(visible);
    const dismissButton = actions.find((node) => {
      const combined = normalize(
        `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`,
      );
      return combined === "dismiss" || combined.startsWith("dismiss ");
    });
    if (click(dismissButton ?? null)) {
      return true;
    }

    const overlayOptions = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".cdk-overlay-container [role='menuitem'], .cdk-overlay-container [role='option'], .cdk-overlay-container button",
      ),
    ).filter(visible);
    if (overlayOptions.length > 0) {
      const backdrop = document.querySelector<HTMLElement>(
        ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing, .cdk-overlay-backdrop",
      );
      if (click(backdrop)) {
        return true;
      }
      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.activeElement?.dispatchEvent(escapeEvent);
      document.dispatchEvent(escapeEvent);
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      return true;
    }

    return false;
  }).catch(() => false);

  if (dismissed) {
    await page.waitForTimeout(600);
  }
  return dismissed;
}

async function selectGeminiImageMode(page: GooglePage): Promise<GeminiImageModeSelection> {
  const livePage = page as unknown as {
    locator: (selector: string) => {
      count: () => Promise<number>;
    };
    waitForTimeout: (timeout: number) => Promise<void>;
  };

  const deselectButtonCount = await livePage
    .locator("button[aria-label*='Deselect Create image']")
    .count()
    .catch(() => 0);
  if (deselectButtonCount > 0) {
    return { status: "already_selected" };
  }

  await dismissGeminiBlockingPopup(page);

  const selection = await page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const lower = (value: string): string => normalize(value).toLowerCase();
    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const click = (element: Element | null): boolean => {
    if (!(element instanceof HTMLElement)) {
        return false;
      }
      element.click();
      return true;
    };

    const directTriggers = Array.from(
      document.querySelectorAll<HTMLElement>("button, [role='button'], [role='menuitem'], [role='option']"),
    ).filter(visible);
    const directImageTrigger = directTriggers.find((node) => {
      const combined = lower(
        `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-test-id") || ""}`,
      );
      if (combined.includes("deselect create image")) {
        return false;
      }
      return /create image|create images|generate image|generate images|image generation/.test(combined);
    });
    if (click(directImageTrigger ?? null)) {
      return {
        status: "selected" as const,
      };
    }

    const modeButton = document.querySelector<HTMLElement>(
      "[data-test-id='bard-mode-menu-button'], button[aria-label*='Open mode picker']",
    );
    const currentMode = normalize(modeButton?.textContent || "");
    if (!click(modeButton)) {
      return {
        status: "unsupported" as const,
        currentMode,
        availableModes: [],
      };
    }

    const optionNodes = Array.from(
      document.querySelectorAll<HTMLElement>("button, [role='menuitem'], [role='option']"),
    ).filter(visible);
    const availableModes = optionNodes
      .map((node) => normalize(node.textContent || node.getAttribute("aria-label") || ""))
      .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
      .slice(0, 20);

    const imageOption = optionNodes.find((node) => {
      const combined = lower(
        `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-test-id") || ""}`,
      );
      return /create image|create images|generate image|generate images|image generation/.test(combined);
    });

    if (click(imageOption ?? null)) {
      return {
        status: "selected" as const,
      };
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));

    return {
      status: "unsupported" as const,
      currentMode,
      availableModes,
    };
  });

  if (selection.status === "selected") {
    await livePage.waitForTimeout(800);
  }
  return selection;
}

async function submitGeminiPrompt(page: GooglePage, prompt: string, mode: GeminiMode): Promise<void> {
  const livePage = page as unknown as {
    locator: (selector: string) => {
      first: () => {
        click: () => Promise<void>;
        fill: (value: string) => Promise<void>;
      };
    };
    getByRole: (
      role: string,
      options?: { name?: string | RegExp },
    ) => { first: () => { click: () => Promise<void> } };
    waitForTimeout: (timeout: number) => Promise<void>;
  };

  await ensureGeminiImageMode(page, mode);
  if (mode === "image") {
    await dismissGeminiBlockingPopup(page);
  }
  const inserted = await page.evaluate(
    ({ value }) => {
      const element = document.querySelector<HTMLElement>("div[role='textbox'][aria-label*='Enter a prompt']");
      if (!element) {
        return false;
      }
      element.focus();
      if (
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement
      ) {
        element.value = value;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (element.isContentEditable) {
        element.textContent = value;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        return true;
      }
      return false;
    },
    { value: prompt },
  ).catch(() => false);
  if (!inserted) {
    const textbox = livePage.locator("div[role='textbox'][aria-label*='Enter a prompt']").first();
    await textbox.click();
    await textbox.fill(prompt);
  }
  await livePage.waitForTimeout(400);
  if (mode === "image") {
    await dismissGeminiBlockingPopup(page);
  }
  const sent = await page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const sendButton = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .filter(visible)
      .find((node) => {
        const combined = normalize(`${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`);
        return combined.includes("send message");
      });
    if (!(sendButton instanceof HTMLElement)) {
      return false;
    }
    sendButton.click();
    return true;
  }).catch(() => false);
  if (!sent) {
    await livePage.getByRole("button", { name: /send message/i }).first().click();
  }
}

async function readGeminiResponseState(
  page: GooglePage,
  mode: GeminiMode,
  previousSnapshot?: {
    responseText?: string | null;
    responseCount?: number;
    imageCount?: number;
  },
): Promise<GeminiWaitResult> {
  const probe = await page.evaluate(
    () => {
        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const bodyText = normalize(document.body?.innerText || "");

        if (bodyText.includes("something went wrong")) {
          const lines = (document.body?.innerText || "")
            .split(/\n+/)
            .map((item) => item.replace(/\s+/g, " ").trim())
            .filter((item) => item.length > 0);
          const matched =
            lines.find((item) => item.toLowerCase().includes("something went wrong")) || "Something went wrong";
          return {
            status: "error" as const,
            message: matched,
          };
        }

        const hasStopControl = Array.from(document.querySelectorAll("button")).some((node) => {
          if (!visible(node)) {
            return false;
          }
          const text = normalize(node.textContent || "");
          const aria = normalize(node.getAttribute("aria-label") || "");
          return text.includes("stop") || aria.includes("stop");
        });

        const hasResponseFeedback = Array.from(document.querySelectorAll("button")).some((node) => {
          if (!visible(node)) {
            return false;
          }
          const aria = normalize(node.getAttribute("aria-label") || "");
          return aria.includes("good response") || aria.includes("bad response");
        });
        const responseCandidates = Array.from(
          document.querySelectorAll("message-content, .model-response-text, .response-container-content, .markdown"),
        )
          .filter(visible)
          .map((node) => normalize(node.textContent || ""))
          .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
        const hasStructuredResponse = responseCandidates.length > 0;
        const responseCount = Array.from(
          document.querySelectorAll("message-content, .model-response-text, .response-container-content, .markdown"),
        ).filter(visible).length;

        let responseText = responseCandidates[responseCandidates.length - 1] || null;
        if (!responseText) {
          const genericText = Array.from(document.querySelectorAll("p, div, span"))
            .filter(visible)
            .map((node) => normalize(node.textContent || ""))
            .filter((value, index, values) => {
              if (!value) {
                return false;
              }
              if (value.includes("gemini is ai and can make mistakes.")) {
                return false;
              }
              return values.indexOf(value) === index;
            });
          responseText = genericText[genericText.length - 1] || null;
        }

        const hasDownloadButton = Array.from(document.querySelectorAll("button,a")).some((node) => {
          if (!visible(node)) {
            return false;
          }
          const text = normalize(node.textContent || "");
          const aria = normalize(node.getAttribute("aria-label") || "");
          return text.includes("download") || aria.includes("download full size image");
        });
        const imageCount = Array.from(document.querySelectorAll("img")).filter((node) => {
          if (!visible(node)) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const src = normalize((node as HTMLImageElement).src || "");
          return rect.width > 64 && rect.height > 64 && src.includes("googleusercontent.com");
        }).length;

        return {
          status: "probe" as const,
          active: hasStopControl,
          imageCount,
          hasDownloadButton,
          responseText,
          responseCount,
          hasResponseFeedback,
          hasStructuredResponse,
          fingerprint: JSON.stringify({
            hasStopControl,
            hasDownloadButton,
            imageCount,
            hasResponseFeedback,
            hasStructuredResponse,
            responseCount,
            responseText: responseText ?? "",
          }),
        };
      },
      {
        mode,
        previousResponseText: mode === "text" ? normalizeGeminiComparableText(previousSnapshot?.responseText) : "",
        previousImageCount: mode === "image" ? (previousSnapshot?.imageCount ?? 0) : 0,
      },
    );

  if (probe.status === "error") {
    return probe;
  }

  if (mode === "image") {
    if (!probe.active && (probe.hasDownloadButton || (probe.imageCount ?? 0) > (previousSnapshot?.imageCount ?? 0))) {
      return {
        status: "ready",
        ...(probe.responseText !== undefined ? { responseText: probe.responseText } : {}),
        ...(probe.imageCount !== undefined ? { imageCount: probe.imageCount } : {}),
      };
    }
    if (shouldTreatGeminiTextResponseAsReady(probe, previousSnapshot)) {
      return {
        status: "ready",
        ...(probe.responseText !== undefined ? { responseText: probe.responseText } : {}),
        ...(probe.imageCount !== undefined ? { imageCount: probe.imageCount } : {}),
      };
    }
    return {
      status: "pending",
      active: probe.active,
      fingerprint: probe.fingerprint,
      ...(probe.responseText !== undefined ? { responseText: probe.responseText } : {}),
      ...(probe.imageCount !== undefined ? { imageCount: probe.imageCount } : {}),
    };
  }

  if (shouldTreatGeminiTextResponseAsReady(probe, previousSnapshot)) {
    return {
      status: "ready",
      ...(probe.responseText !== undefined ? { responseText: probe.responseText } : {}),
    };
  }

  return {
    status: "pending",
    active: probe.active,
    fingerprint: probe.fingerprint,
    ...(probe.responseText !== undefined ? { responseText: probe.responseText } : {}),
  };
}

async function waitForGeminiResponse(
  page: GooglePage,
  mode: GeminiMode,
  timeoutMs: number,
  previousSnapshot?: {
    responseText?: string | null;
    responseCount?: number;
    imageCount?: number;
  },
): Promise<GeminiWaitResult> {
  const startedAt = Date.now();
  const hardDeadline = startedAt + Math.max(timeoutMs * 3, timeoutMs + 120_000);
  let idleDeadline = startedAt + timeoutMs;
  let previousFingerprint = "";

  while (Date.now() < hardDeadline && Date.now() < idleDeadline) {
    const state = await readGeminiResponseState(page, mode, previousSnapshot);
    if (state.status === "error") {
      return state;
    }
    if (state.status === "ready") {
      await page.waitForTimeout(800);
      return state;
    }
    if (state.fingerprint && state.fingerprint !== previousFingerprint) {
      previousFingerprint = state.fingerprint;
      idleDeadline = Date.now() + timeoutMs;
    }
    if (state.active) {
      idleDeadline = Date.now() + timeoutMs;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(`timeout waiting for Gemini ${mode} response`);
}

async function readGeminiChatResult(page: GooglePage, prompt: string, mode: GeminiMode): Promise<{
  conversationUrl: string;
  responseText: string | null;
  responseCount: number;
  images: Array<{ index: number; src: string }>;
}> {
  return await page.evaluate(
    ({ prompt: sentPrompt, mode: requestedMode }) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const isGeneratedGeminiImage = (node: HTMLImageElement): boolean => {
        const rect = node.getBoundingClientRect();
        const src = normalize(node.src);
        return rect.width > 64 && rect.height > 64 && src.includes("googleusercontent.com");
      };

      const imageEntries = Array.from(document.querySelectorAll<HTMLImageElement>("img"))
        .filter((node) => visible(node) && isGeneratedGeminiImage(node))
        .map((node, index) => ({
          index,
          src: normalize(node.src),
        }));

      const responseCandidates = Array.from(
        document.querySelectorAll("message-content, .model-response-text, .response-container-content, .markdown"),
      )
        .filter(visible)
        .map((node) => normalize(node.textContent || ""))
        .filter((value, index, values) => value.length > 0 && value !== sentPrompt && values.indexOf(value) === index);
      const responseCount = Array.from(
        document.querySelectorAll("message-content, .model-response-text, .response-container-content, .markdown"),
      ).filter(visible).length;

      let responseText = responseCandidates[responseCandidates.length - 1];
      if (!responseText && requestedMode === "text") {
        const genericText = Array.from(document.querySelectorAll("p, div, span"))
          .filter(visible)
          .map((node) => normalize(node.textContent || ""))
          .filter((value, index, values) => {
            if (!value || value === sentPrompt) {
              return false;
            }
            if (value.includes("Gemini is AI and can make mistakes.")) {
              return false;
            }
            return values.indexOf(value) === index;
          });
        responseText = genericText[genericText.length - 1];
      }

      return {
        conversationUrl: window.location.href,
        responseText: responseText || null,
        responseCount,
        images: imageEntries,
      };
    },
    {
      prompt,
      mode,
    },
  );
}

async function readVisibleGeminiImages(page: GooglePage): Promise<Array<{ index: number; src: string }>> {
  return await page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isGeneratedGeminiImage = (node: HTMLImageElement): boolean => {
      const rect = node.getBoundingClientRect();
      const src = normalize(node.src);
      return rect.width > 64 && rect.height > 64 && src.includes("googleusercontent.com");
    };

    return Array.from(document.querySelectorAll<HTMLImageElement>("img"))
      .filter((node) => visible(node) && isGeneratedGeminiImage(node))
      .map((node, index) => ({
        index,
        src: normalize(node.src),
      }));
  });
}

function inferImageExtension(src: string, contentType: string | null): { extension: string; mimeType?: string } {
  const normalizedType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedType === "image/png") {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (normalizedType === "image/jpeg") {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (normalizedType === "image/webp") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  try {
    const pathname = new URL(src).pathname;
    const extension = extname(pathname);
    if (extension) {
      return { extension };
    }
  } catch {
    // Ignore URL parsing failure and fall back to png.
  }
  return { extension: ".png", mimeType: "image/png" };
}

async function saveGeminiImageFromSrc(
  src: string,
  artifactDir: string,
  index: number,
): Promise<GeminiImageArtifact> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`image fetch failed with status ${response.status}`);
  }
  const { extension, mimeType } = inferImageExtension(src, response.headers.get("content-type"));
  const filename = `gemini-image-${index + 1}${extension}`;
  const path = join(artifactDir, filename);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(path, bytes);
  return {
    kind: "file",
    name: filename,
    path,
    imageIndex: index,
    ...(mimeType ? { mimeType } : {}),
  };
}

async function downloadGeminiImages(
  page: GooglePage,
  limit: number,
  timeoutMs: number,
): Promise<Array<{ index: number; artifact: GeminiImageArtifact }>> {
  const livePage = page as unknown as {
    locator: (selector: string) => {
      count: () => Promise<number>;
      nth: (index: number) => { click: () => Promise<void> };
    };
    waitForEvent: (
      event: "download",
      options?: { timeout?: number },
    ) => Promise<{ suggestedFilename: () => string; saveAs: (path: string) => Promise<void> }>;
  };

  const buttonLocator = livePage.locator("button[aria-label='Download full size image']");
  const buttonCount = await buttonLocator.count();
  const visibleImages = await readVisibleGeminiImages(page);
  if (buttonCount === 0 && visibleImages.length === 0) {
    return [];
  }

  const artifactDir = await mkdtemp(join(tmpdir(), GEMINI_ARTIFACT_DIR_PREFIX));
  const items: Array<{ index: number; artifact: GeminiImageArtifact }> = [];
  const maxItems = Math.min(limit, Math.max(buttonCount, visibleImages.length));

  for (let index = 0; index < maxItems; index += 1) {
    let artifact: GeminiImageArtifact | undefined;
    if (index < buttonCount) {
      try {
        const downloadPromise = livePage.waitForEvent("download", { timeout: timeoutMs });
        await buttonLocator.nth(index).click();
        const download = await downloadPromise;
        const suggestedName = download.suggestedFilename();
        const suggestedExtension = extname(suggestedName);
        const extension = suggestedExtension || ".png";
        const filename = suggestedName
          ? suggestedExtension
            ? suggestedName
            : `${suggestedName}${extension}`
          : `gemini-image-${index + 1}${extension}`;
        const path = join(artifactDir, filename);
        await download.saveAs(path);
        artifact = {
          kind: "file",
          name: filename,
          path,
          imageIndex: index,
          ...(extension === ".png" ? { mimeType: "image/png" } : {}),
        };
      } catch {
        // Some attached-browser flows do not surface Playwright download events.
      }
    }
    const visibleImage = visibleImages[index];
    if (!artifact && visibleImage) {
      artifact = await saveGeminiImageFromSrc(visibleImage.src, artifactDir, index);
    }
    if (!artifact) {
      continue;
    }
    items.push({
      index,
      artifact,
    });
  }

  return items;
}

export const manifest: AdapterManifest = {
  id: "google",
  displayName: "Google",
  version: "0.1.0",
  bridgeApiVersion: "1.0.0",
  defaultUrl: GEMINI_URL,
  hostPatterns: ["google.com", "*.google.com"],
  authPolicy: {
    mode: "bootstrap_then_attach",
    authProbeTool: "auth.get",
    allowAnonymousTools: true,
  },
};

export function createAdapter(): SiteAdapter {
  return {
    name: "adapter-google",
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }, { page }) => {
      const livePage = page as unknown as GooglePage;
      const args = toRecord(input);

      if (name === "auth.get") {
        const result = await detectGoogleAuthState(livePage);
        return {
          state: result.state,
          url: result.url,
          title: result.title,
          signals: result.signals,
          source: "adapter-google",
        };
      }

      if (name === "page.get") {
        return {
          url: livePage.url(),
          title: await livePage.title().catch(() => ""),
          source: "adapter-google",
        };
      }

      if (name === "search.web") {
        const query = readString(args.query);
        if (!query) {
          return errorResult("VALIDATION_ERROR", "query is required");
        }
        const limit = normalizePositiveInteger(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
        const hl = readString(args.hl) ?? "en";
        return await runGoogleSearch(livePage, query, limit, hl);
      }

      if (name === "gemini.chat") {
        const authError = await requireGeminiAuthentication(livePage);
        if (authError) {
          return authError;
        }

        const prompt = readString(args.prompt);
        if (!prompt) {
          return errorResult("VALIDATION_ERROR", "prompt is required");
        }

        const mode = args.mode === "image" ? "image" : "text";
        const timeoutMs = normalizePositiveInteger(args.timeoutMs, DEFAULT_GEMINI_TIMEOUT_MS, 1_000, MAX_GEMINI_TIMEOUT_MS);
        const downloadImages =
          typeof args.downloadImages === "boolean" ? args.downloadImages : mode === "image";
        let imageModeSelection: GeminiImageModeSelection = { status: "not_needed" };

        await ensureGeminiPage(livePage);
        const previousSnapshot = await readGeminiChatResult(livePage, prompt, mode).catch(() => ({
          conversationUrl: livePage.url(),
          responseText: null,
          responseCount: 0,
          images: [],
        }));
        if (mode === "image") {
          imageModeSelection = await selectGeminiImageMode(livePage);
        }
        await submitGeminiPrompt(livePage, prompt, mode);
        try {
          const waitResult = await waitForGeminiResponse(livePage, mode, timeoutMs, {
            responseText: previousSnapshot.responseText,
            responseCount: previousSnapshot.responseCount,
            imageCount: previousSnapshot.images.length,
          });
          if (waitResult.status === "error") {
            return errorResult("UPSTREAM_CHANGED", "Gemini failed to complete the request", {
              mode,
              message: waitResult.message,
              url: livePage.url(),
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errorResult("ACTION_UNCONFIRMED", `Gemini response did not finish: ${message}`);
        }

        const result = await readGeminiChatResult(livePage, prompt, mode);
        const downloads =
          mode === "image" && downloadImages
            ? await downloadGeminiImages(livePage, Math.max(1, result.images.length || 1), timeoutMs).catch(() => [])
            : [];

        if (mode === "image" && result.images.length === 0 && downloads.length === 0) {
          if (imageModeSelection.status === "unsupported") {
            return errorResult(
              "UNSUPPORTED_IN_CURRENT_UI",
              "Gemini image generation mode is not available in the current UI or account",
              {
                currentMode: imageModeSelection.currentMode ?? "",
                availableModes: (imageModeSelection.availableModes ?? []) as unknown as JsonValue,
                responseText: result.responseText ?? "",
                url: result.conversationUrl,
              },
            );
          }
          return errorResult("NO_IMAGES_GENERATED", "Gemini did not return any downloadable images", {
            responseText: result.responseText ?? "",
            url: result.conversationUrl,
          });
        }

        return {
          prompt,
          mode,
          conversationUrl: result.conversationUrl,
          responseText: result.responseText,
          images: result.images.map((image) => ({
            ...image,
            artifact: downloads.find((item) => item.index === image.index)?.artifact ?? null,
          })),
          source: "dom",
        };
      }

      if (name === "gemini.image.download") {
        const authError = await requireGeminiAuthentication(livePage);
        if (authError) {
          return authError;
        }

        const conversationUrl = readString(args.conversationUrl);
        if (conversationUrl) {
          if (!isGeminiConversationUrl(conversationUrl)) {
            return errorResult("URL_NOT_ALLOWED", "conversationUrl must be a Gemini conversation URL");
          }
          await livePage.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await livePage.waitForTimeout(2_000);
        } else {
          await ensureGeminiPage(livePage);
        }

        const timeoutMs = normalizePositiveInteger(args.timeoutMs, DEFAULT_GEMINI_TIMEOUT_MS, 1_000, MAX_GEMINI_TIMEOUT_MS);
        const limit = normalizePositiveInteger(args.limit, 8, 1, 8);
        try {
          await waitForGeminiResponse(livePage, "image", Math.min(timeoutMs, 10_000));
        } catch {
          // The page may already be settled; downloads below remain authoritative.
        }
        const items = await downloadGeminiImages(livePage, limit, timeoutMs);
        if (items.length === 0) {
          return errorResult("NO_IMAGES", "no downloadable Gemini images are visible");
        }
        return {
          conversationUrl: livePage.url(),
          items,
          source: "dom",
        };
      }

      if (name === "page.navigate") {
        const url = readString(args.url);
        if (!url) {
          return errorResult("VALIDATION_ERROR", "url is required");
        }
        if (!isGoogleOwnedUrl(url)) {
          return errorResult("URL_NOT_ALLOWED", "url must stay within google.com hosts");
        }
        await livePage.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        return {
          ok: true,
          url: livePage.url(),
          title: normalizeText(await livePage.title().catch(() => "")),
          source: "adapter-google",
        };
      }

      if (name === "page.inspect") {
        const selector = typeof args.selector === "string" ? args.selector : undefined;
        const limit = normalizePositiveInteger(args.limit, 20, 1, 100);
        const inspected = await inspectPage(livePage, selector, limit);
        if (typeof inspected === "object" && inspected !== null && "error" in inspected) {
          return inspected;
        }
        return {
          ...(inspected as Record<string, unknown>),
          source: "adapter-google",
        };
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
  };
}
