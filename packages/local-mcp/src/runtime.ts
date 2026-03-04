/**
 * This module boots a Playwright page and WebMCP gateway for one target site session.
 * It depends on site presets and Playwright gateway APIs so local-mcp can proxy browser-side tool execution.
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
import { resolveSiteDefinition, type SupportedSite } from "./sites.js";

export type BrowserEngine = "chromium" | "firefox" | "webkit";

export type LocalMcpRuntimeOptions = {
  site: SupportedSite;
  url?: string;
  browser?: BrowserEngine;
  headless?: boolean;
  userDataDir?: string;
  preferNative?: boolean;
};

export type LocalMcpRuntime = {
  site: SupportedSite;
  targetUrl: string;
  mode: "native" | "shim";
  headless: boolean;
  page: Page;
  gateway: LocalMcpGateway;
  close: () => Promise<void>;
};

function resolveBrowserType(browser: BrowserEngine): BrowserType {
  if (browser === "firefox") {
    return firefox;
  }
  if (browser === "webkit") {
    return webkit;
  }
  return chromium;
}

export async function startLocalMcpRuntime(options: LocalMcpRuntimeOptions): Promise<LocalMcpRuntime> {
  const site = resolveSiteDefinition(options.site);
  const browserEngine = options.browser ?? "chromium";
  const headless = options.headless ?? false;
  const browserType = resolveBrowserType(browserEngine);
  const targetUrl = options.url ?? site.defaultUrl;

  let profileDirFromTemp = false;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "webmcp-local-mcp-")));
  if (!options.userDataDir) {
    profileDirFromTemp = true;
  }

  let context: BrowserContext | undefined;
  let gatewaySession: WebMcpPageGateway | undefined;

  const cleanup = async (): Promise<void> => {
    await gatewaySession?.close().catch(() => {
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

  try {
    context = await browserType.launchPersistentContext(userDataDir, {
      headless,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    const gatewayOptions: CreateWebMcpPageGatewayOptions = {
      fallbackAdapter: site.createFallbackAdapter(),
      preferNative: options.preferNative ?? true,
    };
    gatewaySession = await createWebMcpPageGateway(page, gatewayOptions);
    const pageGateway = gatewaySession;

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await cleanup();
    };

    const gateway: LocalMcpGateway = {
      listTools: async (): Promise<ReadonlyArray<WebMcpToolDefinition>> => {
        return await pageGateway.listTools();
      },
      callTool: async (name: string, input: Record<string, unknown>): Promise<JsonValue> => {
        return await pageGateway.callTool(name, input as JsonValue);
      },
    };

    return {
      site: options.site,
      targetUrl,
      mode: gatewaySession.mode,
      headless,
      page,
      gateway,
      close,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
