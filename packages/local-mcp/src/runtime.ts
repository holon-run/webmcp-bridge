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
  type SiteAdapter,
  type WebMcpPageGateway,
  type WebMcpResourceDefinition,
  type WebMcpToolDefinition,
} from "@webmcp-bridge/playwright";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Frame,
  type Page,
} from "playwright";
import type { LocalMcpGateway } from "./server.js";
import type { SiteDefinition } from "./sites.js";

const NAVIGATION_TIMEOUT_MS = 5_000;
const LAUNCH_RETRY_DELAY_MS = 750;
const MAX_LAUNCH_ATTEMPTS = 2;
const GATEWAY_RECOVERABLE_ERROR_SNIPPETS = [
  "Execution context was destroyed",
  "Cannot find context with specified id",
  "Target page, context or browser has been closed",
  "WebMCP bridge invoke handler missing",
];
const LAUNCH_RETRY_ERROR_SNIPPETS = [
  "Target page, context or browser has been closed",
  "Opening in existing browser session.",
  "ProcessSingleton",
];

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
  browserUrl?: string;
  chromiumLoginWorkaround?: boolean;
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
  ownerSessionEnded: Promise<void>;
  openWindow: () => Promise<"focused" | "opened">;
  close: () => Promise<void>;
};

type AuthState = "authenticated" | "auth_required" | "challenge_required";

function isChromiumAutomationWorkaroundEnabled(enabledOverride?: boolean): boolean {
  if (enabledOverride !== undefined) {
    return enabledOverride;
  }
  const value = process.env.WEBMCP_CHROMIUM_LOGIN_WORKAROUND;
  return value === "1" || value === "true";
}

function createChromiumLaunchOptions(
  headless: boolean,
  browserChannel: BrowserChannel | undefined,
  chromiumLoginWorkaround: boolean | undefined,
): {
  headless: boolean;
  viewport: null;
  chromiumSandbox: boolean;
  channel?: string;
  ignoreDefaultArgs?: string[];
} {
  const launchOptions: {
    headless: boolean;
    viewport: null;
    chromiumSandbox: boolean;
    channel?: string;
    ignoreDefaultArgs?: string[];
  } = {
    headless,
    viewport: null,
    chromiumSandbox: true,
  };
  if (isChromiumAutomationWorkaroundEnabled(chromiumLoginWorkaround)) {
    // Experimental: remove the most obvious automation marker for login surfaces.
    launchOptions.ignoreDefaultArgs = ["--enable-automation"];
  }
  if (browserChannel) {
    launchOptions.channel = browserChannel;
  }
  return launchOptions;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableLaunchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return LAUNCH_RETRY_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

async function launchPersistentContextWithRetry(
  browserType: BrowserType,
  userDataDir: string,
  launchOptions: {
    headless: boolean;
    viewport: null;
    channel?: string;
    args?: string[];
    ignoreDefaultArgs?: string[];
  },
): Promise<BrowserContext> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    try {
      return await browserType.launchPersistentContext(userDataDir, launchOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_LAUNCH_ATTEMPTS || !isRetryableLaunchError(error)) {
        throw error;
      }
      await sleep(LAUNCH_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function connectToExternalBrowserContext(browserUrl: string): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const browser = await chromium.connectOverCDP(browserUrl);
  const context = browser.contexts()[0];
  if (context) {
    return { browser, context };
  }
  await browser.close().catch(() => {
    // Cleanup should be best-effort when attach validation fails.
  });
  throw new Error(
    "SESSION_NOT_AVAILABLE: no persistent browser context found at --browser-url. Open the target Chromium profile with remote debugging enabled before starting local-mcp.",
  );
}

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

export function resolveRecoveryNavigationUrl(
  currentUrl: string | undefined,
  targetUrl: string,
  hostPatterns: string[],
): string | undefined {
  if (!currentUrl || !currentUrl.trim()) {
    return targetUrl;
  }
  return isUrlAllowed(currentUrl, hostPatterns) ? undefined : targetUrl;
}

function readAuthState(value: unknown): AuthState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const state = (value as { state?: unknown }).state;
  if (state === "authenticated" || state === "auth_required" || state === "challenge_required") {
    return state;
  }
  return undefined;
}

export function shouldDeferBridgeForAuthState(state: AuthState | undefined): boolean {
  return state === "auth_required" || state === "challenge_required";
}

export function shouldEndOwnerSessionAfterPageClose(headless: boolean, openPageCount: number): boolean {
  return !headless && openPageCount === 0;
}

type PageLike = Pick<Page, "url" | "isClosed">;

export function selectPreferredPage<T extends PageLike>(
  pages: ReadonlyArray<T>,
  targetUrl: string,
  hostPatterns: string[],
): T | undefined {
  const openPages = pages.filter((entry) => !entry.isClosed());
  if (openPages.length === 0) {
    return undefined;
  }
  const exactTargetPage = openPages.find((entry) => entry.url() === targetUrl);
  if (exactTargetPage) {
    return exactTargetPage;
  }
  let targetHost = "";
  try {
    targetHost = new URL(targetUrl).hostname;
  } catch {
    // Ignore target URL parsing failures here; caller already validates targetUrl separately.
  }
  if (targetHost) {
    const exactHostPage = openPages.find((entry) => {
      try {
        return new URL(entry.url()).hostname === targetHost;
      } catch {
        return false;
      }
    });
    if (exactHostPage) {
      return exactHostPage;
    }
  }
  const allowedHostPage = openPages.find((entry) => isUrlAllowed(entry.url(), hostPatterns));
  if (allowedHostPage) {
    return allowedHostPage;
  }
  return openPages[0];
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

export function isRecoverableGatewayError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return GATEWAY_RECOVERABLE_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
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
  const browserUrl = options.browserUrl;
  const headless = options.headless ?? false;
  if (browserChannel && browserEngine !== "chromium") {
    throw new Error(`CONFIG_ERROR: --browser-channel requires --browser chromium (received ${browserEngine})`);
  }
  if (browserUrl && browserEngine !== "chromium") {
    throw new Error(`CONFIG_ERROR: --browser-url requires --browser chromium (received ${browserEngine})`);
  }
  if (browserUrl && browserChannel) {
    throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --browser-channel");
  }
  if (options.chromiumLoginWorkaround && browserEngine !== "chromium") {
    throw new Error(
      `CONFIG_ERROR: --chromium-login-workaround requires --browser chromium (received ${browserEngine})`,
    );
  }
  if (browserUrl && options.chromiumLoginWorkaround) {
    throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --chromium-login-workaround");
  }
  const browserType = resolveBrowserType(browserEngine);
  const targetUrl = resolveTargetUrl(options.url, site.manifest.defaultUrl);
  if (!isUrlAllowed(targetUrl, site.manifest.hostPatterns)) {
    throw new Error("URL_NOT_ALLOWED: target url host is not allowed by adapter hostPatterns");
  }

  let profileDirFromTemp = false;
  const userDataDir =
    browserUrl ? undefined : (options.userDataDir ?? (await mkdtemp(join(tmpdir(), "webmcp-local-mcp-"))));
  if (!browserUrl && !options.userDataDir) {
    profileDirFromTemp = true;
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let currentPage: Page | undefined;
  let currentGatewaySession: WebMcpPageGateway | undefined;
  let currentMode: "native" | "polyfill" | "adapter-shim" = "native";
  let gatewayStale = false;
  let runtimeClosing = false;
  let pageLifecycleCleanup: (() => void) | undefined;
  let pageGatewayResourceCleanup: (() => void) | undefined;
  let ownerSessionEndedResolved = false;
  let resolveOwnerSessionEnded!: () => void;
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  const ownerSessionEnded = new Promise<void>((resolve) => {
    resolveOwnerSessionEnded = resolve;
  });

  const signalOwnerSessionEnded = (): void => {
    if (ownerSessionEndedResolved) {
      return;
    }
    ownerSessionEndedResolved = true;
    resolveOwnerSessionEnded();
  };

  const cleanup = async (): Promise<void> => {
    await currentGatewaySession?.close().catch(() => {
      // Cleanup should be best-effort when process is terminating.
    });
    if (deferredAdapterStarted && deferredAdapter && currentPage && !currentPage.isClosed()) {
      await deferredAdapter.stop?.({ page: currentPage }).catch(() => {
        // Cleanup should be best-effort when process is terminating.
      });
    }
    pageGatewayResourceCleanup?.();
    pageLifecycleCleanup?.();
    if (browser) {
      await browser.close().catch(() => {
        // Cleanup should be best-effort when process is terminating.
      });
    } else {
      await context?.close().catch(() => {
        // Cleanup should be best-effort when process is terminating.
      });
    }
    if (profileDirFromTemp) {
      await rm(userDataDir as string, { recursive: true, force: true }).catch(() => {
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
  const authProbeTool = site.manifest.authProbeTool;
  const deferBridgeUntilAuthenticated =
    site.manifest.deferBridgeUntilAuthenticated === true &&
    typeof authProbeTool === "string" &&
    authProbeTool.length > 0 &&
    typeof fallbackAdapterFactory === "function";
  let deferredAdapter: SiteAdapter | undefined;
  let deferredAdapterStarted = false;

  const ensureDeferredAdapterStarted = async (page: Page): Promise<SiteAdapter | undefined> => {
    if (!deferBridgeUntilAuthenticated) {
      return undefined;
    }
    if (!deferredAdapter && fallbackAdapterFactory) {
      deferredAdapter = fallbackAdapterFactory();
    }
    if (!deferredAdapter) {
      return undefined;
    }
    if (!deferredAdapterStarted) {
      await deferredAdapter.start?.({ page });
      deferredAdapterStarted = true;
    }
    return deferredAdapter;
  };

  const callDeferredAdapterTool = async (
    page: Page,
    name: string,
    input: JsonValue,
  ): Promise<JsonValue> => {
    const adapter = await ensureDeferredAdapterStarted(page);
    if (!adapter) {
      throw new Error("SESSION_NOT_AVAILABLE: fallback adapter is unavailable");
    }
    return await adapter.callTool({ name, input }, { page });
  };

  const listDeferredAdapterTools = async (page: Page): Promise<WebMcpToolDefinition[]> => {
    const adapter = await ensureDeferredAdapterStarted(page);
    if (!adapter) {
      return [];
    }
    const tools = await adapter.listTools({ page });
    return tools.map((tool) => ({
      ...tool,
      inputSchema: tool.inputSchema ?? { type: "object" },
    }));
  };

  const shouldDeferGatewayCreation = async (page: Page): Promise<boolean> => {
    if (!deferBridgeUntilAuthenticated || !authProbeTool) {
      return false;
    }
    const result = await callDeferredAdapterTool(page, authProbeTool, {} as JsonValue);
    return shouldDeferBridgeForAuthState(readAuthState(result));
  };

  const initializePageSession = async (navigate = true): Promise<void> => {
    if (!context) {
      throw new Error("SESSION_NOT_AVAILABLE: browser context is unavailable");
    }
    await currentGatewaySession?.close().catch(() => {
      // Session replacement should be best-effort.
    });
    currentGatewaySession = undefined;

    const reusablePage = selectPreferredPage(context.pages(), targetUrl, site.manifest.hostPatterns);
    currentPage = reusablePage ?? (await context.newPage());
    pageLifecycleCleanup?.();
    const pageForEvents = currentPage;
    const markGatewayStale = (): void => {
      gatewayStale = true;
    };
    const handlePageClose = (): void => {
      markGatewayStale();
      queueMicrotask(() => {
        if (runtimeClosing) {
          return;
        }
        const openPageCount = context?.pages().filter((entry) => !entry.isClosed()).length ?? 0;
        if (shouldEndOwnerSessionAfterPageClose(headless, openPageCount)) {
          signalOwnerSessionEnded();
        }
      });
    };
    const handleFrameNavigation = (frame: Frame): void => {
      if (frame === pageForEvents.mainFrame()) {
        markGatewayStale();
      }
    };
    pageForEvents.on("framenavigated", handleFrameNavigation);
    pageForEvents.on("close", handlePageClose);
    pageLifecycleCleanup = (): void => {
      const pageEvents = pageForEvents as unknown as {
        removeListener?: {
          (event: "framenavigated", listener: (frame: Frame) => void): unknown;
          (event: "close", listener: () => void): unknown;
        };
      };
      pageEvents.removeListener?.("framenavigated", handleFrameNavigation);
      pageEvents.removeListener?.("close", handlePageClose);
    };
    if (navigate) {
      try {
        await pageForEvents.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        throw mapNavigationError(error, targetUrl, "goto");
      }
    }

    if (await shouldDeferGatewayCreation(pageForEvents)) {
      pageGatewayResourceCleanup?.();
      pageGatewayResourceCleanup = undefined;
      currentMode = deferredAdapter ? "adapter-shim" : "polyfill";
      gatewayStale = false;
      return;
    }

    currentGatewaySession = await createWebMcpPageGateway(pageForEvents, gatewayOptions);
    pageGatewayResourceCleanup?.();
    pageGatewayResourceCleanup = currentGatewaySession.onResourceUpdated((uri) => {
      for (const listener of resourceUpdatedListeners) {
        listener(uri);
      }
    });
    if (navigate && currentGatewaySession.mode === "polyfill") {
      try {
        await pageForEvents.reload({
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        throw mapNavigationError(error, targetUrl, "reload");
      }
      await waitForPolyfillTools(currentGatewaySession);
    } else if (currentGatewaySession.mode === "polyfill") {
      await waitForPolyfillTools(currentGatewaySession).catch(() => {
        // Recovery should still retry the original operation once even if tools are not visible yet.
      });
    }
    currentMode = currentGatewaySession.mode;
    gatewayStale = false;
  };

  const rebuildGatewaySession = async (): Promise<void> => {
    if (!currentPage || currentPage.isClosed()) {
      await initializePageSession(true);
      return;
    }
    const recoveryNavigationUrl = resolveRecoveryNavigationUrl(
      currentPage.url(),
      targetUrl,
      site.manifest.hostPatterns,
    );
    if (recoveryNavigationUrl) {
      try {
        await currentPage.goto(recoveryNavigationUrl, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        throw mapNavigationError(error, recoveryNavigationUrl, "goto");
      }
    }
    await initializePageSession(false);
  };

  const withGatewayRecovery = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (gatewayStale || !currentGatewaySession) {
      await rebuildGatewaySession();
    }
    try {
      return await operation();
    } catch (error) {
      if (!isRecoverableGatewayError(error)) {
        throw error;
      }
      await rebuildGatewaySession();
      return await operation();
    }
  };

  const maybeEnsureGatewaySession = async (): Promise<boolean> => {
    if (!currentPage || currentPage.isClosed()) {
      throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
    }
    if (currentGatewaySession && !gatewayStale) {
      return true;
    }
    await rebuildGatewaySession();
    return Boolean(currentGatewaySession);
  };

  try {
    if (browserUrl) {
      const attachedSession = await connectToExternalBrowserContext(browserUrl);
      browser = attachedSession.browser;
      context = attachedSession.context;
    } else {
      const launchOptions =
        browserEngine === "chromium"
          ? createChromiumLaunchOptions(headless, browserChannel, options.chromiumLoginWorkaround)
          : ({
              headless,
              viewport: null,
            } as {
              headless: boolean;
              viewport: null;
              channel?: string;
            });
      context = await launchPersistentContextWithRetry(browserType, userDataDir as string, launchOptions);
    }
    await initializePageSession();

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      runtimeClosing = true;
      await cleanup();
    };

    const openWindow = async (): Promise<"focused" | "opened"> => {
      if (headless) {
        throw new Error(
          "UNSUPPORTED_IN_HEADLESS_SESSION: bridge.open requires a headed local-mcp session. Start the bridge with --no-headless.",
        );
      }
      if (!currentPage || currentPage.isClosed()) {
        await initializePageSession(true);
        if (!currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        await currentPage.bringToFront();
        return "opened";
      }
      await maybeEnsureGatewaySession();
      await currentPage.bringToFront();
      return "focused";
    };

    const gateway: LocalMcpGateway = {
      listTools: async (): Promise<ReadonlyArray<WebMcpToolDefinition>> => {
        if (!currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        if (!(await maybeEnsureGatewaySession())) {
          return await listDeferredAdapterTools(currentPage);
        }
        return await withGatewayRecovery(async () => await currentGatewaySession!.listTools());
      },
      callTool: async (name: string, input: Record<string, unknown>): Promise<JsonValue> => {
        if (!currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        if (!(await maybeEnsureGatewaySession())) {
          return await callDeferredAdapterTool(currentPage, name, input as JsonValue);
        }
        return await withGatewayRecovery(
          async () => await currentGatewaySession!.callTool(name, input as JsonValue),
        );
      },
      listResources: async (): Promise<ReadonlyArray<WebMcpResourceDefinition>> => {
        if (!currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        if (!(await maybeEnsureGatewaySession())) {
          return [];
        }
        return await withGatewayRecovery(async () => await currentGatewaySession!.listResources());
      },
      readResource: async (uri: string): Promise<JsonValue> => {
        if (!currentPage || currentPage.isClosed()) {
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        }
        if (!(await maybeEnsureGatewaySession())) {
          throw new Error(`RESOURCE_NOT_FOUND: ${uri}`);
        }
        return await withGatewayRecovery(async () => await currentGatewaySession!.readResource(uri));
      },
      onResourceUpdated: (listener) => {
        resourceUpdatedListeners.add(listener);
        return () => {
          resourceUpdatedListeners.delete(listener);
        };
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
      ownerSessionEnded,
      openWindow,
      close,
    };
  } catch (error) {
    runtimeClosing = true;
    await cleanup();
    throw error;
  }
}
