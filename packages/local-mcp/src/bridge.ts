/**
 * This module composes runtime startup with the stdio MCP server into one lifecycle handle.
 * It depends on site-source resolution, runtime, and server modules so CLI and tests can start a complete local-mcp bridge in one call.
 */

import type { Readable, Writable } from "node:stream";
import {
  createLocalMcpStdioServer,
  type LocalMcpStdioServer,
  type LocalMcpStdioServerOptions,
} from "./server.js";
import {
  startLocalMcpRuntime,
  type LocalMcpRuntime,
  type BrowserEngine,
} from "./runtime.js";
import {
  createNativeSiteDefinition,
  resolveSiteSource,
  type BuiltinSite,
  type SiteDefinition,
} from "./sites.js";

export type StartLocalMcpBridgeOptions = {
  site?: BuiltinSite;
  adapterModule?: string;
  moduleBaseDir?: string;
  url?: string;
  browser?: BrowserEngine;
  headless?: boolean;
  userDataDir?: string;
  preferNative?: boolean;
  serviceVersion: string;
  autoLoginFallback?: boolean;
  input?: Readable;
  output?: Writable;
  onError?: (error: unknown) => void;
};

export type LocalMcpBridgeHandle = {
  site: string;
  targetUrl: string;
  mode: "native" | "polyfill" | "adapter-shim";
  headless: boolean;
  close: () => Promise<void>;
};

type AuthState = "authenticated" | "auth_required" | "challenge_required";

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

async function startRuntime(
  options: StartLocalMcpBridgeOptions,
  siteDefinition: SiteDefinition,
  headless: boolean,
): Promise<LocalMcpRuntime> {
  const runtimeOptions = {
    siteDefinition,
    headless,
  } as {
    siteDefinition: SiteDefinition;
    headless: boolean;
    url?: string;
    browser?: BrowserEngine;
    userDataDir?: string;
    preferNative?: boolean;
  };
  if (options.url !== undefined) {
    runtimeOptions.url = options.url;
  }
  if (options.browser !== undefined) {
    runtimeOptions.browser = options.browser;
  }
  if (options.userDataDir !== undefined) {
    runtimeOptions.userDataDir = options.userDataDir;
  }
  if (options.preferNative !== undefined) {
    runtimeOptions.preferNative = options.preferNative;
  }
  return await startLocalMcpRuntime(runtimeOptions);
}

async function resolveRuntime(options: StartLocalMcpBridgeOptions): Promise<LocalMcpRuntime> {
  const hasAdapterSource = Boolean(options.site || options.adapterModule);
  let siteDefinition: SiteDefinition;
  if (hasAdapterSource) {
    const sourceOptions = {} as {
      site?: string;
      adapterModule?: string;
      moduleBaseDir?: string;
    };
    if (options.site !== undefined) {
      sourceOptions.site = options.site;
    }
    if (options.adapterModule !== undefined) {
      sourceOptions.adapterModule = options.adapterModule;
    }
    if (options.moduleBaseDir !== undefined) {
      sourceOptions.moduleBaseDir = options.moduleBaseDir;
    }
    siteDefinition = await resolveSiteSource(sourceOptions);
  } else if (options.url) {
    siteDefinition = createNativeSiteDefinition(options.url);
  } else {
    throw new Error("CONFIG_ERROR: provide --url or one of --site/--adapter-module");
  }

  const requestedHeadless = options.headless ?? false;
  const primary = await startRuntime(options, siteDefinition, requestedHeadless);

  const autoLoginFallback = options.autoLoginFallback ?? true;
  const authProbeTool = siteDefinition.manifest.authProbeTool;
  if (!autoLoginFallback || !requestedHeadless || !authProbeTool) {
    return primary;
  }

  try {
    const authResult = await primary.gateway.callTool(authProbeTool, {});
    const state = readAuthState(authResult);
    if (state !== "auth_required" && state !== "challenge_required") {
      return primary;
    }
  } catch {
    // Ignore auth probing failures and keep current runtime.
    return primary;
  }

  await primary.close();
  return await startRuntime(options, siteDefinition, false);
}

export async function startLocalMcpBridge(options: StartLocalMcpBridgeOptions): Promise<LocalMcpBridgeHandle> {
  const runtime = await resolveRuntime(options);

  let server: LocalMcpStdioServer | undefined;
  try {
    const serverOptions: LocalMcpStdioServerOptions = {
      gateway: runtime.gateway,
      bridgeControl: {
        getState: () => ({
          site: runtime.site,
          targetUrl: runtime.targetUrl,
          mode: runtime.mode,
          headless: runtime.headless,
        }),
        openWindow: runtime.openWindow,
        closeBridge: async () => {
          await server?.close();
          await runtime.close();
        },
      },
      serviceVersion: options.serviceVersion,
    };
    if (options.input !== undefined) {
      serverOptions.input = options.input;
    }
    if (options.output !== undefined) {
      serverOptions.output = options.output;
    }
    if (options.onError !== undefined) {
      serverOptions.onError = options.onError;
    }

    server = createLocalMcpStdioServer(serverOptions);
    await server.start();
  } catch (error) {
    await runtime.close();
    throw error;
  }

  let closed = false;
  return {
    site: runtime.site,
    targetUrl: runtime.targetUrl,
    mode: runtime.mode,
    headless: runtime.headless,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await server?.close();
      await runtime.close();
    },
  };
}
