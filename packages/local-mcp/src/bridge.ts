/**
 * This module composes runtime startup with the stdio MCP server into one lifecycle handle.
 * It depends on site resolution, runtime startup, and session-control helpers so local-mcp can keep one MCP process alive across runtime, bootstrap, and attach transitions.
 */

import type { Readable, Writable } from "node:stream";
import {
  createLocalMcpStdioServer,
  type LocalBridgeSessionRestartOptions,
  type LocalBridgeState,
  type LocalMcpGateway,
  type LocalMcpStdioServer,
  type LocalMcpStdioServerOptions,
} from "./server.js";
import {
  startLocalMcpRuntime,
  type BrowserChannel,
  type BrowserEngine,
  type LocalMcpRuntime,
} from "./runtime.js";
import {
  assertAuthSensitiveBrowserSupport,
  backupAndResetProfile,
  describeSessionStateFromAuth,
  ensureManagedProfile,
  isProcessRunning,
  launchBootstrapBrowser,
  launchManagedAttachBrowser,
  readSessionMetadata,
  resolveAuthPolicy,
  stopManagedBrowser,
  updateSessionMetadata,
  type BridgeAuthState,
  type BridgeControlMode,
  type BridgeSessionOwnership,
  type BridgeSessionState,
  type SessionMetadata,
  type SessionMetadataPatch,
} from "./session.js";
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
  controlMode: BridgeControlMode;
  mode: "native" | "polyfill" | "adapter-shim" | "control-only";
  headless: boolean;
  close: () => Promise<void>;
};

type RuntimeMode = "native" | "polyfill" | "adapter-shim" | "control-only";
type RuntimeStartOptions = {
  siteDefinition: SiteDefinition;
  url?: string;
  browser?: BrowserEngine;
  browserChannel?: BrowserChannel;
  browserUrl?: string;
  chromiumLoginWorkaround?: boolean;
  headless?: boolean;
  userDataDir?: string;
  preferNative?: boolean;
  autoLoginFallback?: boolean;
};

function readAuthState(value: unknown): BridgeAuthState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "unknown";
  }
  const state = (value as { state?: unknown }).state;
  if (state === "authenticated" || state === "auth_required" || state === "challenge_required") {
    return state;
  }
  return "unknown";
}

async function resolveSiteDefinitionFromBridgeOptions(options: StartLocalMcpBridgeOptions): Promise<SiteDefinition> {
  const hasAdapterSource = Boolean(options.site || options.adapterModule);
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
    return await resolveSiteSource(sourceOptions);
  }
  if (options.url) {
    return createNativeSiteDefinition(options.url);
  }
  throw new Error("CONFIG_ERROR: provide --url or one of --site/--adapter-module");
}

async function startRuntime(options: RuntimeStartOptions): Promise<LocalMcpRuntime> {
  return await startLocalMcpRuntime(options);
}

function buildRuntimeStartOptions(
  baseOptions: StartLocalMcpBridgeOptions,
  siteDefinition: SiteDefinition,
  controlMode: "launch" | "attach",
  headless: boolean,
  browserUrl?: string,
): RuntimeStartOptions {
  const nextOptions: RuntimeStartOptions = {
    siteDefinition,
    headless,
  };
  if (baseOptions.url !== undefined) {
    nextOptions.url = baseOptions.url;
  }
  if (baseOptions.browser !== undefined) {
    nextOptions.browser = baseOptions.browser;
  }
  if (baseOptions.userDataDir !== undefined) {
    nextOptions.userDataDir = baseOptions.userDataDir;
  }
  if (baseOptions.preferNative !== undefined) {
    nextOptions.preferNative = baseOptions.preferNative;
  }
  if (baseOptions.autoLoginFallback !== undefined) {
    nextOptions.autoLoginFallback = baseOptions.autoLoginFallback;
  }
  if (controlMode === "attach") {
    if (!browserUrl) {
      throw new Error("CONFIG_ERROR: attach mode requires a browserUrl");
    }
    if (baseOptions.browserChannel !== undefined) {
      throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --browser-channel");
    }
    if (baseOptions.chromiumLoginWorkaround !== undefined) {
      throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --chromium-login-workaround");
    }
    nextOptions.browserUrl = browserUrl;
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

export async function startLocalMcpBridge(options: StartLocalMcpBridgeOptions): Promise<LocalMcpBridgeHandle> {
  const siteDefinition = await resolveSiteDefinitionFromBridgeOptions(options);
  const authPolicy = resolveAuthPolicy(siteDefinition.manifest);
  const targetUrl = options.url?.trim() || siteDefinition.manifest.defaultUrl?.trim() || "";
  if (!targetUrl) {
    throw new Error("CONFIG_ERROR: no target url provided (missing --url and manifest.defaultUrl)");
  }

  if (authPolicy.mode === "bootstrap_then_attach") {
    assertAuthSensitiveBrowserSupport(options.browser, options.userDataDir);
  }

  let runtime: LocalMcpRuntime | undefined;
  let runtimeMode: RuntimeMode = "control-only";
  let controlMode: BridgeControlMode = "none";
  let ownership: BridgeSessionOwnership = "none";
  let authState: BridgeAuthState = "unknown";
  let sessionState: BridgeSessionState =
    authPolicy.mode === "bootstrap_then_attach" ? "profile_missing" : "runtime_active";
  let browserUrl = options.browserUrl;
  let browserPid: number | undefined;
  let headless = options.headless ?? false;
  let lastBackupPath: string | undefined;
  let metadata: SessionMetadata | undefined;
  let server: LocalMcpStdioServer | undefined;
  let closed = false;
  let lifecycleTransition = Promise.resolve();
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  let unsubscribeRuntimeResourceUpdates: (() => void) | undefined;
  let ownerSessionGeneration = 0;

  const profilePath = options.userDataDir;
  const metadataFallback = profilePath
    ? {
        site: siteDefinition.id,
        targetUrl,
        authPolicy,
      }
    : undefined;

  const refreshStatus = (): LocalBridgeState => {
    const state: LocalBridgeState = {
      site: siteDefinition.id,
      targetUrl,
      controlMode,
      ...(browserUrl !== undefined ? { browserUrl } : {}),
      mode: runtimeMode,
      headless,
      authPolicyMode: authPolicy.mode,
      authState,
      sessionState,
      ownership,
      ...(profilePath !== undefined ? { profilePath } : {}),
      ...(browserPid !== undefined ? { browserPid } : {}),
      ...(lastBackupPath !== undefined ? { lastBackupPath } : {}),
    };
    return state;
  };

  const syncFromMetadata = (nextMetadata: SessionMetadata): void => {
    metadata = nextMetadata;
    controlMode = nextMetadata.controlMode;
    browserUrl = nextMetadata.browserUrl;
    browserPid = nextMetadata.browserPid;
    authState = nextMetadata.authState;
    sessionState = nextMetadata.sessionState;
    ownership = nextMetadata.ownership;
    if (nextMetadata.lastBackupPath !== undefined) {
      lastBackupPath = nextMetadata.lastBackupPath;
    }
    if (runtime === undefined) {
      runtimeMode = "control-only";
      headless = false;
    }
  };

  const writeMetadata = async (patch: SessionMetadataPatch): Promise<void> => {
    if (!profilePath || !metadataFallback) {
      return;
    }
    const nextMetadata = await updateSessionMetadata(profilePath, metadataFallback, patch);
    syncFromMetadata(nextMetadata);
  };

  const bindRuntime = (nextRuntime: LocalMcpRuntime, nextOwnership: BridgeSessionOwnership): void => {
    runtime = nextRuntime;
    runtimeMode = nextRuntime.mode;
    controlMode = nextRuntime.controlMode;
    headless = nextRuntime.headless;
    ownership = nextOwnership;
    unsubscribeRuntimeResourceUpdates?.();
    unsubscribeRuntimeResourceUpdates = nextRuntime.gateway.onResourceUpdated((uri) => {
      for (const listener of resourceUpdatedListeners) {
        listener(uri);
      }
    });
    ownerSessionGeneration += 1;
    const generation = ownerSessionGeneration;
    void nextRuntime.ownerSessionEnded.then(() => {
      if (closed || generation !== ownerSessionGeneration) {
        return;
      }
      void closeResources().catch((error) => {
        options.onError?.(error);
      });
    });
  };

  const clearRuntime = (): void => {
    runtime = undefined;
    runtimeMode = "control-only";
    unsubscribeRuntimeResourceUpdates?.();
    unsubscribeRuntimeResourceUpdates = undefined;
  };

  const closeRuntime = async (): Promise<void> => {
    if (!runtime) {
      return;
    }
    const activeRuntime = runtime;
    clearRuntime();
    await activeRuntime.close();
  };

  const probeRuntimeAuthState = async (activeRuntime: LocalMcpRuntime): Promise<BridgeAuthState> => {
    if (!authPolicy.authProbeTool) {
      return "authenticated";
    }
    try {
      const result = await activeRuntime.gateway.callTool(authPolicy.authProbeTool, {});
      return readAuthState(result);
    } catch {
      return "unknown";
    }
  };

  const closeResourcesInternal = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribeRuntimeResourceUpdates?.();
    const activeRuntime = runtime;
    clearRuntime();
    const results = await Promise.allSettled([server?.close(), activeRuntime?.close()]);
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (firstFailure) {
      throw firstFailure.reason;
    }
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

  const closeResources = async (): Promise<void> => {
    await runLifecycleTransition(async () => {
      await closeResourcesInternal();
    });
  };

  const bootstrapSessionInternal = async (nextAuthState: BridgeAuthState = "unknown"): Promise<LocalBridgeState> => {
    if (authPolicy.mode !== "bootstrap_then_attach" || !profilePath) {
      throw new Error("UNSUPPORTED_SESSION_CONTROL: bootstrap is available only for auth-sensitive managed sessions");
    }
    await closeRuntime();
    if (metadata?.ownership === "managed") {
      await stopManagedBrowser(metadata);
    }
    await ensureManagedProfile(profilePath);
    const bootstrapOptions = {
      targetUrl,
      userDataDir: profilePath,
    } as {
      targetUrl: string;
      userDataDir: string;
      browserChannel?: BrowserChannel;
    };
    if (options.browserChannel !== undefined) {
      bootstrapOptions.browserChannel = options.browserChannel;
    }
    const launchResult = await launchBootstrapBrowser(bootstrapOptions);
    const bootstrapPatch: SessionMetadataPatch = {
      sessionState: nextAuthState === "unknown" ? "bootstrap_active" : describeSessionStateFromAuth(nextAuthState),
      authState: nextAuthState,
      controlMode: "bootstrap",
      ownership: "external",
      browserUrl: null,
      browserPid: null,
    };
    if (launchResult.pid !== undefined) {
      bootstrapPatch.browserPid = launchResult.pid;
    }
    await writeMetadata(bootstrapPatch);
    return refreshStatus();
  };

  const activateRuntime = async (
    nextRuntime: LocalMcpRuntime,
    nextOwnership: BridgeSessionOwnership,
    nextBrowserUrl?: string,
    nextBrowserPid?: number,
  ): Promise<LocalBridgeState> => {
    const nextAuthState = await probeRuntimeAuthState(nextRuntime);
    bindRuntime(nextRuntime, nextOwnership);
    browserUrl = nextBrowserUrl;
    browserPid = nextBrowserPid;
    authState = nextAuthState;
    sessionState = "runtime_active";
    if (profilePath && metadataFallback) {
      const runtimePatch: SessionMetadataPatch = {
        sessionState: "runtime_active",
        authState: nextAuthState,
        controlMode: nextRuntime.controlMode,
        ownership: nextOwnership,
      };
      if (nextBrowserUrl !== undefined) {
        runtimePatch.browserUrl = nextBrowserUrl;
      } else {
        runtimePatch.browserUrl = null;
      }
      if (nextBrowserPid !== undefined) {
        runtimePatch.browserPid = nextBrowserPid;
      } else {
        runtimePatch.browserPid = null;
      }
      await writeMetadata(runtimePatch);
    }
    return refreshStatus();
  };

  const attachSessionInternal = async (requestedBrowserUrl?: string): Promise<LocalBridgeState> => {
    const explicitBrowserUrl = requestedBrowserUrl?.trim() || options.browserUrl?.trim();
    const activeBrowserUrl = explicitBrowserUrl || browserUrl;
    const nextOwnership: BridgeSessionOwnership = explicitBrowserUrl ? "external" : "managed";

    if (runtime) {
      await closeRuntime();
    }

    let managedAttachPid: number | undefined;
    let attachBrowserUrl = activeBrowserUrl;

    if (!attachBrowserUrl) {
      if (authPolicy.mode !== "bootstrap_then_attach" || !profilePath) {
        throw new Error("CONFIG_ERROR: bridge.session.attach requires browserUrl when no managed attach session exists");
      }
      await ensureManagedProfile(profilePath);
      const attachOptions = {
        targetUrl,
        userDataDir: profilePath,
      } as {
        targetUrl: string;
        userDataDir: string;
        browserChannel?: BrowserChannel;
      };
      if (options.browserChannel !== undefined) {
        attachOptions.browserChannel = options.browserChannel;
      }
      const managedAttach = await launchManagedAttachBrowser(attachOptions);
      attachBrowserUrl = managedAttach.browserUrl;
      managedAttachPid = managedAttach.pid;
    }

    try {
      const nextRuntime = await startRuntime(
        buildRuntimeStartOptions(options, siteDefinition, "attach", false, attachBrowserUrl),
      );
      const nextAuthState = await probeRuntimeAuthState(nextRuntime);
      if (
        authPolicy.mode === "bootstrap_then_attach" &&
        !explicitBrowserUrl &&
        (nextAuthState === "auth_required" || nextAuthState === "challenge_required")
      ) {
        await nextRuntime.close();
        return await bootstrapSessionInternal(nextAuthState);
      }
      return await activateRuntime(nextRuntime, nextOwnership, attachBrowserUrl, managedAttachPid ?? browserPid);
    } catch (error) {
      if (managedAttachPid && profilePath && metadataFallback) {
        const cleanupMetadata = await updateSessionMetadata(profilePath, metadataFallback, {
          controlMode: "none",
          ownership: "none",
          browserUrl: null,
          browserPid: null,
        });
        await stopManagedBrowser({
          ...cleanupMetadata,
          ownership: "managed",
          browserPid: managedAttachPid,
        });
      }
      await closeResourcesInternal().catch(options.onError);
      throw error;
    }
  };

  const restartRuntimeInternal = async (
    restartOptions: LocalBridgeSessionRestartOptions,
  ): Promise<LocalBridgeState> => {
    if (closed) {
      throw new Error("SESSION_NOT_AVAILABLE: local-mcp bridge session is closed");
    }
    const requestedControlMode = restartOptions.controlMode ?? (controlMode === "attach" ? "attach" : "launch");
    if (requestedControlMode === "attach") {
      return await attachSessionInternal(restartOptions.browserUrl);
    }
    if (restartOptions.browserUrl !== undefined) {
      throw new Error("CONFIG_ERROR: bridge.session.restart with controlMode=launch cannot accept browserUrl");
    }
    if (authPolicy.mode === "bootstrap_then_attach") {
      throw new Error(
        "UNSUPPORTED_SESSION_CONTROL: launch restarts are not supported for bootstrap_then_attach sessions",
      );
    }

    const previousRuntime = runtime;
    const previousState = refreshStatus();
    await closeRuntime();

    try {
      const nextRuntime = await startRuntime(
        buildRuntimeStartOptions(
          options,
          siteDefinition,
          "launch",
          restartOptions.headless ?? (previousRuntime?.headless ?? (options.headless ?? false)),
        ),
      );
      return await activateRuntime(nextRuntime, "managed");
    } catch (error) {
      if (previousRuntime) {
        try {
          const recoveredRuntime = await startRuntime(
            buildRuntimeStartOptions(options, siteDefinition, "launch", previousState.headless),
          );
          await activateRuntime(recoveredRuntime, previousState.ownership);
        } catch (recoveryError) {
          options.onError?.(recoveryError);
          await closeResourcesInternal().catch(options.onError);
        }
      } else {
        await closeResourcesInternal().catch(options.onError);
      }
      throw error;
    }
  };

  const restartRuntime = async (restartOptions: LocalBridgeSessionRestartOptions): Promise<LocalBridgeState> => {
    return await runLifecycleTransition(async () => await restartRuntimeInternal(restartOptions));
  };

  const resetProfileInternal = async (): Promise<LocalBridgeState> => {
    if (!profilePath || !metadataFallback) {
      throw new Error("UNSUPPORTED_SESSION_CONTROL: reset_profile requires a managed --user-data-dir");
    }
    await closeRuntime();
    if (metadata?.ownership === "managed") {
      await stopManagedBrowser(metadata);
    }
    const resetResult = await backupAndResetProfile(profilePath, metadataFallback);
    syncFromMetadata(resetResult.metadata);
    lastBackupPath = resetResult.backupPath;
    if (authPolicy.mode === "bootstrap_then_attach") {
      return await bootstrapSessionInternal();
    }
    return refreshStatus();
  };

  const initializeControlPlane = async (): Promise<void> => {
    if (authPolicy.mode !== "bootstrap_then_attach") {
      const nextControlMode = options.browserUrl ? "attach" : "launch";
      const nextRuntime = await startRuntime(
        buildRuntimeStartOptions(options, siteDefinition, nextControlMode, headless, options.browserUrl),
      );
      await activateRuntime(nextRuntime, nextControlMode === "attach" ? "external" : "managed", options.browserUrl);
      return;
    }

    const managedProfilePath = profilePath as string;
    metadata = await readSessionMetadata(managedProfilePath, metadataFallback as NonNullable<typeof metadataFallback>);
    syncFromMetadata(metadata);

    if (options.browserUrl) {
      await attachSessionInternal(options.browserUrl);
      return;
    }

    const hasRunningManagedAttach =
      metadata.controlMode === "attach" &&
      metadata.browserUrl !== undefined &&
      metadata.ownership === "managed" &&
      (await isProcessRunning(metadata.browserPid));
    if (hasRunningManagedAttach) {
      await attachSessionInternal(metadata.browserUrl);
      return;
    }

    if (metadata.authState === "authenticated") {
      await attachSessionInternal();
      return;
    }

    await bootstrapSessionInternal(
      metadata.authState === "auth_required" || metadata.authState === "challenge_required"
        ? metadata.authState
        : "unknown",
    );
  };

  await initializeControlPlane();

  const gateway: LocalMcpGateway = {
    listTools: async () => {
      if (!runtime) {
        return [];
      }
      return await runtime.gateway.listTools();
    },
    callTool: async (name: string, input: Record<string, unknown>) => {
      if (!runtime) {
        throw new Error(
          "SESSION_NOT_AVAILABLE: page tools are unavailable while local-mcp is waiting for bootstrap or attach",
        );
      }
      return await runtime.gateway.callTool(name, input);
    },
    listResources: async () => {
      if (!runtime) {
        return [];
      }
      return await runtime.gateway.listResources();
    },
    readResource: async (uri: string) => {
      if (!runtime) {
        throw new Error(`RESOURCE_NOT_FOUND: ${uri}`);
      }
      return await runtime.gateway.readResource(uri);
    },
    onResourceUpdated: (listener) => {
      resourceUpdatedListeners.add(listener);
      return () => {
        resourceUpdatedListeners.delete(listener);
      };
    },
  };

  try {
    const serverOptions: LocalMcpStdioServerOptions = {
      gateway,
      bridgeControl: {
        getState: refreshStatus,
        openWindow: async () => {
          if (runtime) {
            return await runtime.openWindow();
          }
          if (authPolicy.mode === "bootstrap_then_attach") {
            await runLifecycleTransition(async () => {
              await bootstrapSessionInternal(authState);
            });
            return "opened";
          }
          throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
        },
        bootstrapSession: async () => {
          return await runLifecycleTransition(async () => await bootstrapSessionInternal(authState));
        },
        attachSession: async (requestedBrowserUrl?: string) => {
          return await runLifecycleTransition(async () => await attachSessionInternal(requestedBrowserUrl));
        },
        restartSession: async (restartOptions: LocalBridgeSessionRestartOptions) => await restartRuntime(restartOptions),
        resetProfile: async () => {
          return await runLifecycleTransition(async () => await resetProfileInternal());
        },
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
    await closeResourcesInternal().catch(options.onError);
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
      return siteDefinition.id;
    },
    get targetUrl() {
      return targetUrl;
    },
    get controlMode() {
      return controlMode;
    },
    get mode() {
      return runtimeMode;
    },
    get headless() {
      return headless;
    },
    close: async (): Promise<void> => {
      input.removeListener("end", handleInputEnded);
      await closeResources();
    },
  };
}
