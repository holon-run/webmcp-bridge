/**
 * This module boots a Playwright page and WebMCP gateway for one target site session.
 * It depends on resolved site definitions and Playwright gateway APIs so local-mcp can proxy browser-side tool execution.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@webmcp-bridge/core";
import {
  createWebMcpPageGateway,
  type CreateWebMcpPageGatewayOptions,
  type WebMcpPageGateway,
  type WebMcpToolDefinition,
} from "@webmcp-bridge/playwright";
import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "playwright";
import type { LocalMcpGateway } from "./server.js";
import type { SiteDefinition } from "./sites.js";

const NAVIGATION_TIMEOUT_MS = 5_000;

export type BrowserEngine = "chromium" | "firefox" | "webkit";
export type BrowserChannel =
  | "chrome"
  | "chrome-beta"
  | "chrome-dev"
  | "chrome-canary"
  | "msedge"
  | "msedge-beta"
  | "msedge-dev"
  | "msedge-canary";

export type LocalMcpRuntimeOptions = {
  siteDefinition: SiteDefinition;
  url?: string;
  browser?: BrowserEngine;
  browserChannel?: BrowserChannel;
  headless?: boolean;
  userDataDir?: string;
  preferNative?: boolean;
};

export type LocalMcpRuntime = {
  site: string;
  siteDefinition: SiteDefinition;
  targetUrl: string;
  mode: "native" | "polyfill" | "adapter-shim";
  headless: boolean;
  page: Page;
  gateway: LocalMcpGateway;
  openWindow: () => Promise<"focused" | "opened">;
  close: () => Promise<void>;
};

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function matchesHostPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    if (!suffix) {
      return false;
    }
    if (normalizedHost === suffix) {
      return false;
    }
    return normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
}

export function isUrlAllowed(url: string, hostPatterns: string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === "about:") {
    return target.href === "about:blank" && hostPatterns.includes("about:blank");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return false;
  }
  return hostPatterns.some((pattern) => matchesHostPattern(target.hostname, pattern));
}

export function resolveTargetUrl(urlOverride: string | undefined, defaultUrl: string | undefined): string {
  const targetUrl = (urlOverride && urlOverride.trim()) || (defaultUrl && defaultUrl.trim()) || "";
  if (!targetUrl) {
    throw new Error("CONFIG_ERROR: no target url provided (missing --url and manifest.defaultUrl)");
  }
  return targetUrl;
}

function resolveBrowserType(browser: BrowserEngine): BrowserType {
  if (browser === "firefox") {
    return firefox;
  }
  if (browser === "webkit") {
    return webkit;
  }
  return chromium;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function mapNavigationError(error: unknown, targetUrl: string, phase: "goto" | "reload"): Error {
  const message = extractErrorMessage(error);
  const normalizedPhase = phase === "goto" ? "open" : "reload";
  if (
    message.includes("ERR_CONNECTION_REFUSED") ||
    message.includes("ERR_NAME_NOT_RESOLVED") ||
    message.includes("ERR_CONNECTION_TIMED_OUT") ||
    message.includes("ERR_INTERNET_DISCONNECTED") ||
    message.includes("Couldn't connect to server")
  ) {
    return new Error(`TARGET_UNREACHABLE: failed to ${normalizedPhase} ${targetUrl}: ${message}`);
  }
  if (message.toLowerCase().includes("timeout")) {
    return new Error(`NAVIGATION_TIMEOUT: timed out trying to ${normalizedPhase} ${targetUrl}: ${message}`);
  }
  return new Error(`NAVIGATION_FAILED: failed to ${normalizedPhase} ${targetUrl}: ${message}`);
}

async function waitForPolyfillTools(
  pageGateway: Pick<WebMcpPageGateway, "listTools">,
  timeoutMs = 5000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tools = await pageGateway.listTools();
    if (tools.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function startLocalMcpRuntime(options: LocalMcpRuntimeOptions): Promise<LocalMcpRuntime> {
  const site = options.siteDefinition;
  const browserEngine = options.browser ?? "chromium";
  const browserChannel = options.browserChannel;
  const headless = options.headless ?? false;
  if (browserChannel && browserEngine !== "chromium") {
    throw new Error(`CONFIG_ERROR: --browser-channel requires --browser chromium (received ${browserEngine})`);
  }
  const browserType = resolveBrowserType(browserEngine);
  const targetUrl = resolveTargetUrl(options.url, site.manifest.defaultUrl);
  if (!isUrlAllowed(targetUrl, site.manifest.hostPatterns)) {
    throw new Error("URL_NOT_ALLOWED: target url host is not allowed by adapter hostPatterns");
  }

  let profileDirFromTemp = false;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "webmcp-local-mcp-")));
  if (!options.userDataDir) {
    profileDirFromTemp = true;
  }

  let context: BrowserContext | undefined;
  let currentPage: Page | undefined;
  let currentGatewaySession: WebMcpPageGateway | undefined;
  let currentMode: "native" | "polyfill" | "adapter-shim" = "native";

  const cleanup = async (): Promise<void> => {
    await currentGatewaySession?.close().catch(() => {
      // Cleanup should be best-effort when process is terminating.
    });
    await context?.close().catch(() => {
      // Cleanup should be best-effort when process is terminating.
    });
    if (profileDirFromTemp) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {
        // Cleanup should be best-effort when process is terminating.
      });
    }
  };

  const gatewayOptions: CreateWebMcpPageGatewayOptions = {
    preferNative: options.preferNative ?? true,
  };
  const fallbackAdapterFactory = site.createFallbackAdapter;
  if (fallbackAdapterFactory) {
    gatewayOptions.fallbackAdapter = fallbackAdapterFactory();
  }

  const initializePageSession = async (): Promise<void> => {
    if (!context) {
      throw new Error("SESSION_NOT_AVAILABLE: browser context is unavailable");
    }
    await currentGatewaySession?.close().catch(() => {
      // Session replacement should be best-effort.
    });
    currentGatewaySession = undefined;

    const reusablePage = context.pages().find((entry) => !entry.isClosed());
    currentPage = reusablePage ?? (await context.newPage());
    try {
      await currentPage.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (error) {
      throw mapNavigationError(error, targetUrl, "goto");
    }

    currentGatewaySession = await createWebMcpPageGateway(currentPage, gatewayOptions);
    if (currentGatewaySession.mode === "polyfill") {
      try {
        await currentPage.reload({
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        throw mapNavigationError(error, targetUrl, "reload");
      }
      await waitForPolyfillTools(currentGatewaySession);
    }
    currentMode = currentGatewaySession.mode;
  };

  try {
    const launchOptions = {
      headless,
      viewport: null,
    } as {
      headless: boolean;
      viewport: null;
      channel?: string;
    };
    if (browserChannel) {
      launchOptions.channel = browserChannel;
    }
    context = await browserType.launchPersistentContext(userDataDir, launchOptions);
    await initializePageSession();

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await cleanup();
    };

    const openWindow = async (): Promise<"focused" | "opened"> => {
      if (headless) {
        throw new Error(
          "UNSUPPORTED_IN_HEADLESS_SESSION: bridge.open requires a headed local-mcp session. Start the bridge with --no-headless.",
        );
      }
      if (!currentPage || currentPage.isClosed()) {
        await initializePageSession();
        if (!currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        await currentPage.bringToFront();
        return "opened";
      }
      await currentPage.bringToFront();
      return "focused";
    };

    const gateway: LocalMcpGateway = {
      listTools: async (): Promise<ReadonlyArray<WebMcpToolDefinition>> => {
        if (!currentGatewaySession || !currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        return await currentGatewaySession.listTools();
      },
      callTool: async (name: string, input: Record<string, unknown>): Promise<JsonValue> => {
        if (!currentGatewaySession || !currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        return await currentGatewaySession.callTool(name, input as JsonValue);
      },
    };

    return {
      get site() {
        return site.id;
      },
      siteDefinition: site,
      get targetUrl() {
        return targetUrl;
      },
      get mode() {
        return currentMode;
      },
      headless,
      get page() {
        return currentPage as Page;
      },
      gateway,
      openWindow,
      close,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
