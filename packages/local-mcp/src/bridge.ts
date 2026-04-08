/**
 * This module composes site/runtime startup with the stdio MCP server into one lifecycle handle.
 * It depends on agent-browser-core orchestration, site resolution, and server wiring so local-mcp stays a thin MCP facade over one browser session.
 */

import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "@webmcp-bridge/core";
import {
  assertAuthSensitiveBrowserSupport,
  resolveAuthPolicy,
  startBrowserSessionController,
  type BrowserSessionStatus,
  type BridgeControlMode,
  type BridgePresentationMode,
} from "@webmcp-bridge/agent-browser-core";
import {
  createLocalMcpStdioServer,
  type LocalBridgePresentationModeSetOptions,
  type LocalBridgeState,
  type LocalMcpGateway,
  type LocalMcpStdioServer,
  type LocalMcpStdioServerOptions,
} from "./server.js";
import {
  resolveCdpConnectUrl,
  startLocalMcpRuntime,
  type BrowserChannel,
  type BrowserEngine,
  type LocalMcpRuntime,
} from "./runtime.js";
import {
  evaluateDebugScript,
  evaluateOverlayTool,
  OverlayStore,
  type InstallOverlayOptions,
  type OverlayListResult,
  type OverlayRecord,
  type UpdateOverlayOptions,
} from "./overlays.js";
import { resolveDefaultUserDataDir } from "./profiles.js";
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
  preferredPresentationMode?: BridgePresentationMode;
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
  mode: "native" | "polyfill" | "adapter-shim" | "overlay-bootstrap" | "control-only";
  presentationMode: BridgePresentationMode;
  preferredPresentationMode: BridgePresentationMode;
  close: () => Promise<void>;
};

type RuntimeStartOptions = {
  siteDefinition: SiteDefinition;
  url?: string;
  browser?: BrowserEngine;
  browserChannel?: BrowserChannel;
  browserUrl?: string;
  browserUrlOrigin?: "external" | "managed";
  chromiumLoginWorkaround?: boolean;
  preferredPresentationMode?: BridgePresentationMode;
  userDataDir?: string;
  preferNative?: boolean;
  autoLoginFallback?: boolean;
};

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
  userDataDir: string | undefined,
  controlMode: "launch" | "attach",
  preferredPresentationMode: BridgePresentationMode,
  browserUrl?: string,
): RuntimeStartOptions {
  const configuredBrowserUrl = baseOptions.browserUrl?.trim() || undefined;
  const nextOptions: RuntimeStartOptions = {
    siteDefinition,
    preferredPresentationMode,
  };
  if (baseOptions.url !== undefined) {
    nextOptions.url = baseOptions.url;
  }
  if (baseOptions.browser !== undefined) {
    nextOptions.browser = baseOptions.browser;
  }
  if (userDataDir !== undefined) {
    nextOptions.userDataDir = userDataDir;
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
    const explicitAttach = configuredBrowserUrl !== undefined;
    if (explicitAttach && baseOptions.browserChannel !== undefined) {
      throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --browser-channel");
    }
    if (explicitAttach && baseOptions.chromiumLoginWorkaround !== undefined) {
      throw new Error("CONFIG_ERROR: --browser-url cannot be combined with --chromium-login-workaround");
    }
    nextOptions.browserUrl = browserUrl;
    nextOptions.browserUrlOrigin = explicitAttach ? "external" : "managed";
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

function toLocalBridgeState(status: BrowserSessionStatus): LocalBridgeState {
  return status;
}

export async function startLocalMcpBridge(options: StartLocalMcpBridgeOptions): Promise<LocalMcpBridgeHandle> {
  const siteDefinition = await resolveSiteDefinitionFromBridgeOptions(options);
  const authPolicy = resolveAuthPolicy(siteDefinition.manifest);
  const targetUrl = options.url?.trim() || siteDefinition.manifest.defaultUrl?.trim() || "";
  if (!targetUrl) {
    throw new Error("CONFIG_ERROR: no target url provided (missing --url and manifest.defaultUrl)");
  }
  const configuredBrowserUrl = options.browserUrl?.trim() || undefined;
  const managedUserDataDir =
    configuredBrowserUrl === undefined
      ? (options.userDataDir ?? resolveDefaultUserDataDir(siteDefinition, targetUrl))
      : undefined;

  if (authPolicy.mode === "bootstrap_then_attach") {
    assertAuthSensitiveBrowserSupport(options.browser, managedUserDataDir);
  }
  const overlayStore = new OverlayStore(siteDefinition.id, managedUserDataDir);
  await overlayStore.load();

  let server: LocalMcpStdioServer | undefined;
  let closeRequested = false;
  let closeResources: () => Promise<void> = async () => {};
  const toolsetListeners = new Set<() => void>();
  const notifyToolsetMayHaveChanged = (): void => {
    for (const listener of toolsetListeners) {
      try {
        listener();
      } catch (error) {
        options.onError?.(error);
      }
    }
  };
  const requestClose = (): void => {
    closeRequested = true;
    if (server === undefined) {
      return;
    }
    void closeResources().catch((error) => {
      options.onError?.(error);
    });
  };
  const controller = await startBrowserSessionController<LocalMcpRuntime>({
    site: siteDefinition.id,
    targetUrl,
    authPolicy,
    ...(managedUserDataDir !== undefined ? { profilePath: managedUserDataDir } : {}),
    ...(options.browserChannel !== undefined ? { browserChannel: options.browserChannel } : {}),
    ...(options.browserUrl !== undefined ? { browserUrl: options.browserUrl } : {}),
    ...(options.preferredPresentationMode !== undefined
      ? { preferredPresentationMode: options.preferredPresentationMode }
      : {}),
    runtimeFactory: async ({ controlMode, preferredPresentationMode, browserUrl }) =>
      await startRuntime(
        buildRuntimeStartOptions(
          options,
          siteDefinition,
          managedUserDataDir,
          controlMode,
          preferredPresentationMode,
          browserUrl,
        ),
      ),
    browserUrlHealthCheck: async (browserUrl) => {
      await resolveCdpConnectUrl(browserUrl);
    },
    onCloseRequested: requestClose,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  const unsubscribeControllerToolset = controller.onToolsetMayHaveChanged(() => {
    notifyToolsetMayHaveChanged();
  });
  let closed = false;
  let lastState = toLocalBridgeState(controller.getState());

  closeResources = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    lastState = toLocalBridgeState(controller.getState());
    unsubscribeControllerToolset();
    const activeServer = server;
    server = undefined;
    const results = await Promise.allSettled([activeServer?.close(), controller.close()]);
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (firstFailure) {
      throw firstFailure.reason;
    }
  };

  const gateway: LocalMcpGateway = {
    listTools: async () => {
      const runtime = controller.getRuntime();
      if (!runtime) {
        return [];
      }
      const pageTools = await runtime.gateway.listTools();
      return [
        ...overlayStore.applyOverrideToolDefinitions(pageTools),
        ...overlayStore.listEnabledAliasToolDefinitions(),
      ];
    },
    callTool: async (name: string, input: Record<string, unknown>) => {
      const runtime = controller.getRuntime();
      if (!runtime) {
        throw new Error(
          "SESSION_NOT_AVAILABLE: page tools are unavailable while local-mcp is waiting for bootstrap or attach",
        );
      }
      const overlayTool = overlayStore.getOverlayTool(name);
      if (overlayTool) {
        return await evaluateOverlayTool(runtime.page, overlayTool.overlay, overlayTool.tool, input);
      }
      const overrideTool = overlayStore.getOverrideTool(name);
      if (overrideTool) {
        return await evaluateOverlayTool(runtime.page, overrideTool.overlay, overrideTool.tool, input);
      }
      return (await runtime.gateway.callTool(name, input)) as Awaited<
        ReturnType<LocalMcpRuntime["gateway"]["callTool"]>
      >;
    },
    listResources: async () => {
      const runtime = controller.getRuntime();
      if (!runtime) {
        return [];
      }
      return await runtime.gateway.listResources();
    },
    readResource: async (uri: string) => {
      const runtime = controller.getRuntime();
      if (!runtime) {
        throw new Error(`RESOURCE_NOT_FOUND: ${uri}`);
      }
      return await runtime.gateway.readResource(uri);
    },
    onResourceUpdated: (listener) => controller.onResourceUpdated(listener),
  };

  try {
    const serverOptions: LocalMcpStdioServerOptions = {
      gateway,
      bridgeControl: {
        getState: () => {
          lastState = toLocalBridgeState(controller.getState());
          return lastState;
        },
        openWindow: async () => await controller.openWindow(),
        bootstrapSession: async () => {
          lastState = toLocalBridgeState(await controller.bootstrapSession());
          return lastState;
        },
        attachSession: async (requestedBrowserUrl?: string) => {
          lastState = toLocalBridgeState(await controller.attachSession(requestedBrowserUrl));
          return lastState;
        },
        debugEval: async (script: string, args: JsonValue) => {
          const runtime = controller.getRuntime();
          if (!runtime) {
            throw new Error("SESSION_NOT_AVAILABLE: debug eval requires an active browser runtime");
          }
          return await evaluateDebugScript(runtime.page, script, args);
        },
        listOverlays: async (): Promise<OverlayListResult> => {
          const runtime = controller.getRuntime();
          const baseTools = runtime ? await runtime.gateway.listTools() : [];
          return overlayStore.list(baseTools.map((tool) => tool.name));
        },
        installOverlay: async (installOptions: InstallOverlayOptions): Promise<OverlayRecord> => {
          const overlay = await overlayStore.install(installOptions);
          notifyToolsetMayHaveChanged();
          return overlay;
        },
        updateOverlay: async (updateOptions: UpdateOverlayOptions): Promise<OverlayRecord> => {
          const overlay = await overlayStore.update(updateOptions);
          notifyToolsetMayHaveChanged();
          return overlay;
        },
        enableOverlay: async (id: string): Promise<OverlayRecord> => {
          const overlay = await overlayStore.enable(id);
          notifyToolsetMayHaveChanged();
          return overlay;
        },
        disableOverlay: async (id: string): Promise<OverlayRecord> => {
          const overlay = await overlayStore.disable(id);
          notifyToolsetMayHaveChanged();
          return overlay;
        },
        deleteOverlay: async (id: string): Promise<void> => {
          await overlayStore.delete(id);
          notifyToolsetMayHaveChanged();
        },
        exportOverlay: async (id: string) => {
          const exported = await overlayStore.exportAdapterDraft({
            id,
            targetUrl,
            siteDisplayName: siteDefinition.manifest.displayName,
            hostPatterns: siteDefinition.manifest.hostPatterns,
          });
          return exported;
        },
        getPresentationMode: () => controller.getPresentationMode(),
        setPresentationMode: async (setModeOptions: LocalBridgePresentationModeSetOptions) => {
          lastState = toLocalBridgeState(await controller.setPresentationMode(setModeOptions));
          return lastState;
        },
        resetProfile: async () => {
          lastState = toLocalBridgeState(await controller.resetProfile());
          await overlayStore.load();
          notifyToolsetMayHaveChanged();
          return lastState;
        },
        closeBridge: async () => {
          await closeResources();
        },
      },
      serviceVersion: options.serviceVersion,
      onToolsetMayHaveChanged: (listener) => {
        toolsetListeners.add(listener);
        return () => {
          toolsetListeners.delete(listener);
        };
      },
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.output !== undefined ? { output: options.output } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    };

    server = createLocalMcpStdioServer(serverOptions);
    await server.start();
    if (closeRequested) {
      await closeResources();
    }
  } catch (error) {
    await closeResources().catch(options.onError);
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
      return lastState.site;
    },
    get targetUrl() {
      return lastState.targetUrl;
    },
    get controlMode() {
      return lastState.controlMode;
    },
    get mode() {
      return lastState.mode;
    },
    get presentationMode() {
      lastState = toLocalBridgeState(controller.getState());
      return lastState.presentationMode;
    },
    get preferredPresentationMode() {
      lastState = toLocalBridgeState(controller.getState());
      return lastState.preferredPresentationMode;
    },
    close: async (): Promise<void> => {
      input.removeListener("end", handleInputEnded);
      await closeResources();
    },
  };
}
