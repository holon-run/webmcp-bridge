/**
 * This module composes runtime startup with the stdio MCP server into one lifecycle handle.
 * It depends on site-source resolution, runtime, and server modules so CLI and tests can start a complete local-mcp bridge in one call.
 */

import type { Readable, Writable } from "node:stream";
import {
  createLocalMcpStdioServer,
  type LocalMcpStdioServer,
  type LocalMcpStdioServerOptions,
  type LocalBridgeSessionRestartOptions,
  type LocalBridgeState,
} from "./server.js";
import {
  startLocalMcpRuntime,
  type LocalMcpRuntime,
  type BrowserEngine,
  type BrowserChannel,
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
  browserChannel?: BrowserChannel;
  browserUrl?: string;
  chromiumLoginWorkaround?: boolean;
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
  controlMode: "launch" | "attach";
  mode: "native" | "polyfill" | "adapter-shim";
  headless: boolean;
  close: () => Promise<void>;
};

type AuthState = "authenticated" | "auth_required" | "challenge_required";
type BridgeSessionConfig = {
  controlMode: "launch" | "attach";
  browserUrl?: string;
  headless: boolean;
};

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

function createInitialSessionConfig(options: StartLocalMcpBridgeOptions): BridgeSessionConfig {
  const sessionConfig: BridgeSessionConfig = {
    controlMode: options.browserUrl ? "attach" : "launch",
    headless: options.headless ?? false,
  };
  if (options.browserUrl !== undefined) {
    sessionConfig.browserUrl = options.browserUrl;
  }
  return sessionConfig;
}

function createRuntimeStartOptions(
  baseOptions: StartLocalMcpBridgeOptions,
  sessionConfig: BridgeSessionConfig,
): StartLocalMcpBridgeOptions {
  const nextOptions: StartLocalMcpBridgeOptions = {
    headless: sessionConfig.headless,
    serviceVersion: baseOptions.serviceVersion,
  };
  if (baseOptions.browser !== undefined) {
    nextOptions.browser = baseOptions.browser;
  }
  if (baseOptions.autoLoginFallback !== undefined) {
    nextOptions.autoLoginFallback = baseOptions.autoLoginFallback;
  }
  if (baseOptions.site !== undefined) {
    nextOptions.site = baseOptions.site;
  }
  if (baseOptions.adapterModule !== undefined) {
    nextOptions.adapterModule = baseOptions.adapterModule;
  }
  if (baseOptions.moduleBaseDir !== undefined) {
    nextOptions.moduleBaseDir = baseOptions.moduleBaseDir;
  }
  if (baseOptions.url !== undefined) {
    nextOptions.url = baseOptions.url;
  }
  if (baseOptions.userDataDir !== undefined) {
    nextOptions.userDataDir = baseOptions.userDataDir;
  }
  if (baseOptions.preferNative !== undefined) {
    nextOptions.preferNative = baseOptions.preferNative;
  }
  if (sessionConfig.controlMode === "attach") {
    if (baseOptions.browserChannel !== undefined) {
      throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --browser-channel");
    }
    if (baseOptions.chromiumLoginWorkaround !== undefined) {
      throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --chromium-login-workaround");
    }
    if (sessionConfig.browserUrl !== undefined) {
      nextOptions.browserUrl = sessionConfig.browserUrl;
    }
    return nextOptions;
  }
  if (baseOptions.browserChannel !== undefined) {
    nextOptions.browserChannel = baseOptions.browserChannel;
  }
  if (baseOptions.chromiumLoginWorkaround !== undefined) {
    nextOptions.chromiumLoginWorkaround = baseOptions.chromiumLoginWorkaround;
  }
  return nextOptions;
}

function normalizeRestartSessionConfig(
  currentSession: BridgeSessionConfig,
  options: LocalBridgeSessionRestartOptions,
): BridgeSessionConfig {
  const requestedControlMode = options.controlMode ?? (options.browserUrl ? "attach" : currentSession.controlMode);
  const headless = options.headless ?? currentSession.headless;
  if (requestedControlMode === "attach") {
    const browserUrl = options.browserUrl ?? currentSession.browserUrl;
    if (!browserUrl) {
      throw new Error("CONFIG_ERROR: bridge.session.attach requires browserUrl when no attach browser is active");
    }
    return {
      controlMode: "attach",
      browserUrl,
      headless,
    };
  }
  if (options.browserUrl !== undefined) {
    throw new Error("CONFIG_ERROR: bridge.session.restart with controlMode=launch cannot accept browserUrl");
  }
  return {
    controlMode: "launch",
    headless,
  };
}

function toBridgeState(runtime: LocalMcpRuntime, sessionConfig: BridgeSessionConfig): LocalBridgeState {
  const state: LocalBridgeState = {
    site: runtime.site,
    targetUrl: runtime.targetUrl,
    controlMode: runtime.controlMode,
    mode: runtime.mode,
    headless: runtime.headless,
  };
  if (sessionConfig.browserUrl !== undefined) {
    state.browserUrl = sessionConfig.browserUrl;
  }
  return state;
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
    browserChannel?: BrowserChannel;
    browserUrl?: string;
    chromiumLoginWorkaround?: boolean;
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
  if (options.browserChannel !== undefined) {
    runtimeOptions.browserChannel = options.browserChannel;
  }
  if (options.browserUrl !== undefined) {
    runtimeOptions.browserUrl = options.browserUrl;
  }
  if (options.chromiumLoginWorkaround !== undefined) {
    runtimeOptions.chromiumLoginWorkaround = options.chromiumLoginWorkaround;
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
  const initialSessionConfig = createInitialSessionConfig(options);
  const baseRuntimeOptions = createRuntimeStartOptions(options, initialSessionConfig);
  let runtime = await resolveRuntime(baseRuntimeOptions);
  let currentSessionConfig = initialSessionConfig;

  let server: LocalMcpStdioServer | undefined;
  let closed = false;
  let lifecycleTransition = Promise.resolve();
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  let unsubscribeRuntimeResourceUpdates: (() => void) | undefined;
  let ownerSessionGeneration = 0;

  const bindRuntime = (nextRuntime: LocalMcpRuntime, sessionConfig: BridgeSessionConfig): void => {
    runtime = nextRuntime;
    currentSessionConfig = sessionConfig;
    unsubscribeRuntimeResourceUpdates?.();
    unsubscribeRuntimeResourceUpdates = runtime.gateway.onResourceUpdated((uri) => {
      for (const listener of resourceUpdatedListeners) {
        listener(uri);
      }
    });
    ownerSessionGeneration += 1;
    const generation = ownerSessionGeneration;
    void runtime.ownerSessionEnded.then(() => {
      if (closed || generation !== ownerSessionGeneration) {
        return;
      }
      void closeResources().catch((error) => {
        options.onError?.(error);
      });
    });
  };

  const runLifecycleTransition = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previousTransition = lifecycleTransition;
    let releaseTransition!: () => void;
    lifecycleTransition = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    await previousTransition.catch(() => {
      // Ignore previous transition failures so later lifecycle operations can still proceed.
    });
    try {
      return await operation();
    } finally {
      releaseTransition();
    }
  };

  const closeResourcesInternal = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribeRuntimeResourceUpdates?.();
    const results = await Promise.allSettled([server?.close(), runtime.close()]);
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (firstFailure) {
      throw firstFailure.reason;
    }
  };

  const closeResources = async (): Promise<void> => {
    await runLifecycleTransition(async () => {
      await closeResourcesInternal();
    });
  };

  const restartRuntimeInternal = async (
    restartOptions: LocalBridgeSessionRestartOptions,
  ): Promise<LocalBridgeState> => {
    if (closed) {
      throw new Error("SESSION_NOT_AVAILABLE: local-mcp bridge session is closed");
    }

    const previousRuntime = runtime;
    const previousSessionConfig = currentSessionConfig;
    const nextSessionConfig = normalizeRestartSessionConfig(previousSessionConfig, restartOptions);
    await previousRuntime.close();

    try {
      const nextRuntime = await resolveRuntime(createRuntimeStartOptions(options, nextSessionConfig));
      bindRuntime(nextRuntime, nextSessionConfig);
      return toBridgeState(nextRuntime, nextSessionConfig);
    } catch (error) {
      try {
        const recoveredRuntime = await resolveRuntime(createRuntimeStartOptions(options, previousSessionConfig));
        bindRuntime(recoveredRuntime, previousSessionConfig);
      } catch (recoveryError) {
        options.onError?.(recoveryError);
        try {
          await closeResourcesInternal();
        } catch (closeError) {
          options.onError?.(closeError);
        }
      }
      throw error;
    }
  };

  const restartRuntime = async (restartOptions: LocalBridgeSessionRestartOptions): Promise<LocalBridgeState> => {
    return await runLifecycleTransition(async () => await restartRuntimeInternal(restartOptions));
  };

  const gateway = {
    listTools: async () => await runtime.gateway.listTools(),
    callTool: async (name: string, input: Record<string, unknown>) => await runtime.gateway.callTool(name, input),
    listResources: async () => await runtime.gateway.listResources(),
    readResource: async (uri: string) => await runtime.gateway.readResource(uri),
    onResourceUpdated: (listener: (uri: string) => void) => {
      resourceUpdatedListeners.add(listener);
      return () => {
        resourceUpdatedListeners.delete(listener);
      };
    },
  } satisfies LocalMcpStdioServerOptions["gateway"];

  bindRuntime(runtime, initialSessionConfig);

  try {
    const serverOptions: LocalMcpStdioServerOptions = {
      gateway,
      bridgeControl: {
        getState: () => toBridgeState(runtime, currentSessionConfig),
        openWindow: async () => await runtime.openWindow(),
        attachSession: async (browserUrl: string) =>
          await restartRuntime({
            controlMode: "attach",
            browserUrl,
          }),
        restartSession: async (restartOptions: LocalBridgeSessionRestartOptions) => await restartRuntime(restartOptions),
        closeBridge: async () => {
          await closeResources();
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
    unsubscribeRuntimeResourceUpdates?.();
    await runtime.close();
    throw error;
  }

  const input = options.input ?? process.stdin;
  const handleInputEnded = (): void => {
    void closeResources().catch((error) => {
      options.onError?.(error);
    });
  };
  input.once("end", handleInputEnded);

  return {
    get site() {
      return runtime.site;
    },
    get targetUrl() {
      return runtime.targetUrl;
    },
    get controlMode() {
      return runtime.controlMode;
    },
    get mode() {
      return runtime.mode;
    },
    get headless() {
      return runtime.headless;
    },
    close: async (): Promise<void> => {
      input.removeListener("end", handleInputEnded);
      await closeResources();
    },
  };
}
