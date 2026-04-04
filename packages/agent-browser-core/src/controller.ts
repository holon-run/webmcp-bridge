/**
 * This module owns browser session lifecycle orchestration above the low-level session/profile helpers.
 * It depends on session metadata/process utilities and an injected runtime factory so agent-browser-core can manage browser ownership without transport-specific code.
 */

import {
  backupAndResetProfile,
  describeSessionStateFromAuth,
  ensureManagedProfile,
  findBrowserProcessForProfile,
  focusBrowserWindow,
  isProcessRunning,
  launchBootstrapBrowser,
  launchManagedAttachBrowser,
  readBrowserProcess,
  readSessionMetadata,
  stopBrowserProcess,
  stopManagedBrowser,
  updateSessionMetadata,
  waitForProcessExit,
  type AuthPolicyMode,
  type BridgeAuthState,
  type BridgeControlMode,
  type BridgePresentationMode,
  type BridgeSessionOwnership,
  type BridgeSessionState,
  type ResolvedAuthPolicy,
  type SessionMetadata,
  type SessionMetadataPatch,
} from "./session.js";
import type { BrowserChannel } from "./runtime.js";

const BOOTSTRAP_BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BOOTSTRAP_PROFILE_RELEASE_DELAY_MS = 500;

export type BrowserSessionRuntimeGateway = {
  callTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  onResourceUpdated: (listener: (uri: string) => void) => () => void;
};

export type BrowserSessionRuntime<TGateway extends BrowserSessionRuntimeGateway = BrowserSessionRuntimeGateway> = {
  controlMode: "launch" | "attach";
  mode: "native" | "polyfill" | "adapter-shim";
  presentationMode: BridgePresentationMode;
  gateway: TGateway;
  ownerSessionEnded: Promise<void>;
  openWindow: () => Promise<"focused" | "opened">;
  close: () => Promise<void>;
};

export type BrowserSessionStatus = {
  site: string;
  targetUrl: string;
  controlMode: BridgeControlMode;
  browserUrl?: string;
  mode: "native" | "polyfill" | "adapter-shim" | "control-only";
  presentationMode: BridgePresentationMode;
  preferredPresentationMode: BridgePresentationMode;
  authPolicyMode: AuthPolicyMode;
  authState: BridgeAuthState;
  sessionState: BridgeSessionState;
  ownership: BridgeSessionOwnership;
  profilePath?: string;
  browserPid?: number;
  lastBackupPath?: string;
};

export type SetPresentationModeOptions = {
  presentationMode: BridgePresentationMode;
};

export type BrowserSessionController<
  TRuntime extends BrowserSessionRuntime = BrowserSessionRuntime,
> = {
  getState: () => BrowserSessionStatus;
  getRuntime: () => TRuntime | undefined;
  onResourceUpdated: (listener: (uri: string) => void) => () => void;
  onToolsetMayHaveChanged: (listener: () => void) => () => void;
  openWindow: () => Promise<"focused" | "opened">;
  bootstrapSession: () => Promise<BrowserSessionStatus>;
  attachSession: (browserUrl?: string) => Promise<BrowserSessionStatus>;
  getPresentationMode: () => BridgePresentationMode;
  setPresentationMode: (options: SetPresentationModeOptions) => Promise<BrowserSessionStatus>;
  resetProfile: () => Promise<BrowserSessionStatus>;
  close: () => Promise<void>;
};

export type StartBrowserSessionControllerOptions<
  TRuntime extends BrowserSessionRuntime = BrowserSessionRuntime,
> = {
  site: string;
  targetUrl: string;
  authPolicy: ResolvedAuthPolicy;
  profilePath?: string;
  browserChannel?: BrowserChannel;
  browserUrl?: string;
  preferredPresentationMode?: BridgePresentationMode;
  runtimeFactory: (options: {
    controlMode: "launch" | "attach";
    preferredPresentationMode: BridgePresentationMode;
    browserUrl?: string;
  }) => Promise<TRuntime>;
  browserUrlHealthCheck?: (browserUrl: string) => Promise<unknown>;
  focusBrowserWindow?: (browserChannel: BrowserChannel | undefined) => Promise<boolean>;
  onCloseRequested?: () => void;
  onError?: (error: unknown) => void;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function startBrowserSessionController<
  TRuntime extends BrowserSessionRuntime,
>(
  options: StartBrowserSessionControllerOptions<TRuntime>,
): Promise<BrowserSessionController<TRuntime>> {
  const configuredBrowserUrl = options.browserUrl?.trim() || undefined;
  let runtime: TRuntime | undefined;
  let runtimeMode: BrowserSessionStatus["mode"] = "control-only";
  let controlMode: BridgeControlMode = "none";
  let ownership: BridgeSessionOwnership = "none";
  let authState: BridgeAuthState = "unknown";
  let sessionState: BridgeSessionState =
    options.authPolicy.mode === "bootstrap_then_attach" ? "profile_missing" : "runtime_active";
  let browserUrl = configuredBrowserUrl;
  let browserPid: number | undefined;
  const configuredPreferredPresentationMode = options.preferredPresentationMode;
  let preferredPresentationMode: BridgePresentationMode = options.preferredPresentationMode ?? "headed";
  let presentationMode: BridgePresentationMode = preferredPresentationMode;
  let lastBackupPath: string | undefined;
  let metadata: SessionMetadata | undefined;
  let closed = false;
  let lifecycleTransition = Promise.resolve();
  let unsubscribeRuntimeResourceUpdates: (() => void) | undefined;
  let ownerSessionGeneration = 0;
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  const toolsetChangedListeners = new Set<() => void>();

  const metadataFallback = options.profilePath
    ? {
        site: options.site,
        targetUrl: options.targetUrl,
        authPolicy: options.authPolicy,
      }
    : undefined;

  const refreshStatus = (): BrowserSessionStatus => {
    const state: BrowserSessionStatus = {
      site: options.site,
      targetUrl: options.targetUrl,
      controlMode,
      ...(browserUrl !== undefined ? { browserUrl } : {}),
      mode: runtimeMode,
      presentationMode,
      preferredPresentationMode,
      authPolicyMode: options.authPolicy.mode,
      authState,
      sessionState,
      ownership,
      ...(options.profilePath !== undefined ? { profilePath: options.profilePath } : {}),
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
    presentationMode = nextMetadata.presentationMode;
    preferredPresentationMode = configuredPreferredPresentationMode ?? nextMetadata.preferredPresentationMode;
    lastBackupPath = nextMetadata.lastBackupPath;
    if (runtime === undefined) {
      runtimeMode = "control-only";
      presentationMode = nextMetadata.controlMode === "bootstrap" ? "headed" : nextMetadata.presentationMode;
    }
  };

  const writeMetadata = async (patch: SessionMetadataPatch): Promise<void> => {
    if (!options.profilePath || !metadataFallback) {
      return;
    }
    const nextMetadata = await updateSessionMetadata(options.profilePath, metadataFallback, patch);
    syncFromMetadata(nextMetadata);
  };

  const notifyToolsetMayHaveChanged = (): void => {
    for (const listener of toolsetChangedListeners) {
      try {
        listener();
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const notifyCloseRequested = (): void => {
    try {
      options.onCloseRequested?.();
    } catch (error) {
      options.onError?.(error);
    }
  };

  const hasRunningBootstrapBrowser = async (sourceMetadata?: SessionMetadata): Promise<boolean> => {
    const activeMetadata = sourceMetadata ?? metadata;
    if (!activeMetadata) {
      return false;
    }
    if (
      options.authPolicy.mode !== "bootstrap_then_attach" ||
      activeMetadata.controlMode !== "bootstrap" ||
      activeMetadata.ownership !== "external"
    ) {
      return false;
    }
    if (await isProcessRunning(activeMetadata.browserPid)) {
      return true;
    }
    if (!options.profilePath) {
      return false;
    }
    const discoveredPid = await findBrowserProcessForProfile(options.profilePath);
    if (!discoveredPid) {
      return false;
    }
    if (discoveredPid !== activeMetadata.browserPid) {
      await writeMetadata({
        browserPid: discoveredPid,
      });
    }
    return true;
  };

  const isOrphanedManagedBrowser = async (pid: number | undefined): Promise<boolean> => {
    const processInfo = await readBrowserProcess(pid);
    return processInfo?.ppid === 1;
  };

  const reapManagedBrowserProcess = async (pid: number | undefined, timeoutErrorPrefix: string): Promise<boolean> => {
    if (!(await isProcessRunning(pid))) {
      return false;
    }
    await stopBrowserProcess(pid);
    if (pid) {
      const didExit = await waitForProcessExit(pid, BOOTSTRAP_BROWSER_CLOSE_TIMEOUT_MS);
      if (!didExit) {
        throw new Error(`${timeoutErrorPrefix}: timed out waiting for managed browser ${String(pid)} to exit`);
      }
      await delay(BOOTSTRAP_PROFILE_RELEASE_DELAY_MS);
    }
    return true;
  };

  const clearManagedBrowserMetadata = async (): Promise<void> => {
    if (options.profilePath && metadataFallback) {
      await updateSessionMetadata(options.profilePath, metadataFallback, {
        controlMode: "none",
        ownership: "none",
        browserUrl: null,
        browserPid: null,
      });
    }
    browserUrl = undefined;
    browserPid = undefined;
  };

  const bindRuntime = (nextRuntime: TRuntime, nextOwnership: BridgeSessionOwnership): void => {
    runtime = nextRuntime;
    runtimeMode = nextRuntime.mode;
    controlMode = nextRuntime.controlMode;
    presentationMode = nextRuntime.presentationMode;
    ownership = nextOwnership;
    unsubscribeRuntimeResourceUpdates?.();
    unsubscribeRuntimeResourceUpdates = nextRuntime.gateway.onResourceUpdated((uri) => {
      for (const listener of resourceUpdatedListeners) {
        listener(uri);
      }
    });
    notifyToolsetMayHaveChanged();
    ownerSessionGeneration += 1;
    const generation = ownerSessionGeneration;
    void nextRuntime.ownerSessionEnded.then(() => {
      if (closed || generation !== ownerSessionGeneration) {
        return;
      }
      notifyCloseRequested();
    });
  };

  const clearRuntime = (): void => {
    runtime = undefined;
    runtimeMode = "control-only";
    unsubscribeRuntimeResourceUpdates?.();
    unsubscribeRuntimeResourceUpdates = undefined;
    notifyToolsetMayHaveChanged();
  };

  const closeRuntime = async (): Promise<void> => {
    if (!runtime) {
      return;
    }
    const activeRuntime = runtime;
    clearRuntime();
    await activeRuntime.close();
  };

  const probeRuntimeAuthState = async (activeRuntime: TRuntime): Promise<BridgeAuthState> => {
    if (!options.authPolicy.authProbeTool) {
      return "authenticated";
    }
    try {
      const result = await activeRuntime.gateway.callTool(options.authPolicy.authProbeTool, {});
      return readAuthState(result);
    } catch {
      return "unknown";
    }
  };

  const closeInternal = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    ownerSessionGeneration += 1;
    const activeMetadata = metadata;
    const activeRuntime = runtime;
    clearRuntime();
    const results = await Promise.allSettled([
      activeRuntime?.close(),
      activeMetadata?.ownership === "managed" ? stopManagedBrowser(activeMetadata) : undefined,
    ]);
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

  const bootstrapSessionInternal = async (
    nextAuthState: BridgeAuthState = "unknown",
  ): Promise<BrowserSessionStatus> => {
    if (options.authPolicy.mode !== "bootstrap_then_attach" || !options.profilePath) {
      throw new Error("UNSUPPORTED_SESSION_CONTROL: bootstrap is available only for auth-sensitive managed sessions");
    }
    await closeRuntime();
    if (await hasRunningBootstrapBrowser()) {
      return refreshStatus();
    }
    if (metadata?.ownership === "managed") {
      await stopManagedBrowser(metadata);
    }
    await ensureManagedProfile(options.profilePath);
    const launchResult = await launchBootstrapBrowser({
      targetUrl: options.targetUrl,
      userDataDir: options.profilePath,
      ...(options.browserChannel !== undefined ? { browserChannel: options.browserChannel } : {}),
    });
    const bootstrapPatch: SessionMetadataPatch = {
      presentationMode: "headed",
      preferredPresentationMode,
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
    notifyToolsetMayHaveChanged();
    return refreshStatus();
  };

  const adoptManagedAttachBrowserAsBootstrap = async (
    nextAuthState: BridgeAuthState,
    nextBrowserPid?: number,
  ): Promise<BrowserSessionStatus> => {
    await closeRuntime();
    const bootstrapPatch: SessionMetadataPatch = {
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: describeSessionStateFromAuth(nextAuthState),
      authState: nextAuthState,
      controlMode: "bootstrap",
      ownership: "external",
      browserUrl: null,
      browserPid: null,
    };
    if (nextBrowserPid !== undefined) {
      bootstrapPatch.browserPid = nextBrowserPid;
    }
    preferredPresentationMode = "headed";
    await writeMetadata(bootstrapPatch);
    notifyToolsetMayHaveChanged();
    return refreshStatus();
  };

  const activateRuntime = async (
    nextRuntime: TRuntime,
    nextOwnership: BridgeSessionOwnership,
    nextBrowserUrl?: string,
    nextBrowserPid?: number,
  ): Promise<BrowserSessionStatus> => {
    const nextAuthState = await probeRuntimeAuthState(nextRuntime);
    bindRuntime(nextRuntime, nextOwnership);
    browserUrl = nextBrowserUrl;
    browserPid = nextBrowserPid;
    authState = nextAuthState;
    sessionState = "runtime_active";
    presentationMode = nextRuntime.presentationMode;
    if (options.profilePath && metadataFallback) {
      const runtimePatch: SessionMetadataPatch = {
        presentationMode: nextRuntime.presentationMode,
        preferredPresentationMode,
        sessionState: "runtime_active",
        authState: nextAuthState,
        controlMode: nextRuntime.controlMode,
        ownership: nextOwnership,
      };
      runtimePatch.browserUrl = nextBrowserUrl ?? null;
      runtimePatch.browserPid = nextBrowserPid ?? null;
      await writeMetadata(runtimePatch);
    }
    return refreshStatus();
  };

  const attachSessionInternal = async (
    requestedBrowserUrl?: string,
    requestedPresentationMode: BridgePresentationMode = preferredPresentationMode,
  ): Promise<BrowserSessionStatus> => {
    const explicitBrowserUrl = requestedBrowserUrl?.trim() || configuredBrowserUrl;
    const relaunchManagedAttachBrowser =
      !explicitBrowserUrl &&
      controlMode === "attach" &&
      ownership === "managed" &&
      requestedPresentationMode !== presentationMode;
    const activeBrowserUrl = explicitBrowserUrl || (relaunchManagedAttachBrowser ? undefined : browserUrl);
    const nextOwnership: BridgeSessionOwnership = explicitBrowserUrl ? "external" : "managed";

    if (runtime) {
      await closeRuntime();
    }

    if (relaunchManagedAttachBrowser) {
      const managedBrowserPid =
        browserPid ?? (options.profilePath ? await findBrowserProcessForProfile(options.profilePath) : undefined);
      await clearManagedBrowserMetadata();
      await reapManagedBrowserProcess(managedBrowserPid, "BROWSER_CLOSE_TIMEOUT");
    }

    let managedAttachPid: number | undefined;
    let attachBrowserUrl = activeBrowserUrl;

    if (!explicitBrowserUrl && attachBrowserUrl && ownership === "managed") {
      const managedBrowserPid =
        browserPid ?? (options.profilePath ? await findBrowserProcessForProfile(options.profilePath) : undefined);
      const managedBrowserRunning = await isProcessRunning(managedBrowserPid);
      const managedBrowserOrphaned = managedBrowserRunning && (await isOrphanedManagedBrowser(managedBrowserPid));
      let managedBrowserUrlHealthy = managedBrowserRunning;
      if (managedBrowserRunning && !managedBrowserOrphaned && options.browserUrlHealthCheck) {
        try {
          await options.browserUrlHealthCheck(attachBrowserUrl);
        } catch {
          managedBrowserUrlHealthy = false;
        }
      }
      if (!managedBrowserRunning || managedBrowserOrphaned || !managedBrowserUrlHealthy) {
        if (managedBrowserRunning) {
          await reapManagedBrowserProcess(managedBrowserPid, "BROWSER_CLOSE_TIMEOUT");
        }
        await clearManagedBrowserMetadata();
        attachBrowserUrl = undefined;
      }
    }

    if (!attachBrowserUrl) {
      if (options.authPolicy.mode !== "bootstrap_then_attach" || !options.profilePath) {
        throw new Error(
          "CONFIG_ERROR: bridge.session.attach requires browserUrl when no managed attach session exists",
        );
      }
      if (!explicitBrowserUrl && (await hasRunningBootstrapBrowser())) {
        const bootstrapPid =
          metadata?.browserPid ??
          (options.profilePath ? await findBrowserProcessForProfile(options.profilePath) : undefined);
        await stopBrowserProcess(bootstrapPid);
        const didExit = await waitForProcessExit(bootstrapPid, BOOTSTRAP_BROWSER_CLOSE_TIMEOUT_MS);
        if (!didExit) {
          throw new Error(
            `BOOTSTRAP_BROWSER_CLOSE_TIMEOUT: timed out waiting for bootstrap browser ${String(bootstrapPid)} to exit`,
          );
        }
        await writeMetadata({
          controlMode: "none",
          ownership: "none",
          browserUrl: null,
          browserPid: null,
        });
        await delay(BOOTSTRAP_PROFILE_RELEASE_DELAY_MS);
      }
      const existingProfileBrowserPid = await findBrowserProcessForProfile(options.profilePath);
      if (existingProfileBrowserPid) {
        await stopBrowserProcess(existingProfileBrowserPid);
        const didExit = await waitForProcessExit(existingProfileBrowserPid, BOOTSTRAP_BROWSER_CLOSE_TIMEOUT_MS);
        if (!didExit) {
          throw new Error(
            `BROWSER_CLOSE_TIMEOUT: timed out waiting for existing browser ${String(existingProfileBrowserPid)} to exit`,
          );
        }
        await delay(BOOTSTRAP_PROFILE_RELEASE_DELAY_MS);
      }
      await ensureManagedProfile(options.profilePath);
      const managedAttach = await launchManagedAttachBrowser({
        targetUrl: options.targetUrl,
        userDataDir: options.profilePath,
        presentationMode: requestedPresentationMode,
        ...(options.browserChannel !== undefined ? { browserChannel: options.browserChannel } : {}),
      });
      attachBrowserUrl = managedAttach.browserUrl;
      managedAttachPid = managedAttach.pid;
    }

    try {
      const nextRuntime = await options.runtimeFactory({
        controlMode: "attach",
        preferredPresentationMode: requestedPresentationMode,
        browserUrl: attachBrowserUrl,
      });
      const nextAuthState = await probeRuntimeAuthState(nextRuntime);
      if (
        options.authPolicy.mode === "bootstrap_then_attach" &&
        !explicitBrowserUrl &&
        (nextAuthState === "auth_required" || nextAuthState === "challenge_required")
      ) {
        if (managedAttachPid && requestedPresentationMode === "headed") {
          bindRuntime(nextRuntime, "managed");
          return await adoptManagedAttachBrowserAsBootstrap(nextAuthState, managedAttachPid);
        }
        await nextRuntime.close();
        return await bootstrapSessionInternal(nextAuthState);
      }
      preferredPresentationMode = requestedPresentationMode;
      return await activateRuntime(nextRuntime, nextOwnership, attachBrowserUrl, managedAttachPid ?? browserPid);
    } catch (error) {
      if (managedAttachPid && options.profilePath && metadataFallback) {
        const cleanupMetadata = await updateSessionMetadata(options.profilePath, metadataFallback, {
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
      await closeInternal().catch(options.onError);
      notifyCloseRequested();
      throw error;
    }
  };

  const setPresentationModeInternal = async (
    setModeOptions: SetPresentationModeOptions,
  ): Promise<BrowserSessionStatus> => {
    if (closed) {
      throw new Error("SESSION_NOT_AVAILABLE: local-mcp bridge session is closed");
    }
    const requestedPresentationMode = setModeOptions.presentationMode;
    const previousRuntime = runtime;
    const previousState = refreshStatus();
    const previousPreferredPresentationMode = preferredPresentationMode;

    if (controlMode === "bootstrap") {
      throw new Error(
        "UNSUPPORTED_SESSION_CONTROL: bridge.session.mode.set is unavailable while the bridge is in bootstrap mode",
      );
    }
    if (ownership === "external") {
      throw new Error(
        "UNSUPPORTED_SESSION_CONTROL: bridge.session.mode.set is unavailable for external attach sessions",
      );
    }
    if (requestedPresentationMode === presentationMode) {
      preferredPresentationMode = requestedPresentationMode;
      if (options.profilePath && metadataFallback) {
        await writeMetadata({
          presentationMode,
          preferredPresentationMode,
        });
      }
      return refreshStatus();
    }
    if (controlMode === "attach") {
      preferredPresentationMode = requestedPresentationMode;
      return await attachSessionInternal(undefined, requestedPresentationMode);
    }

    await closeRuntime();
    preferredPresentationMode = requestedPresentationMode;

    try {
      const nextRuntime = await options.runtimeFactory({
        controlMode: "launch",
        preferredPresentationMode: requestedPresentationMode,
      });
      return await activateRuntime(nextRuntime, "managed");
    } catch (error) {
      preferredPresentationMode = previousPreferredPresentationMode;
      if (previousRuntime) {
        try {
          const recoveredRuntime = await options.runtimeFactory({
            controlMode: "launch",
            preferredPresentationMode: previousState.presentationMode,
          });
          await activateRuntime(recoveredRuntime, previousState.ownership);
        } catch (recoveryError) {
          options.onError?.(recoveryError);
          await closeInternal().catch(options.onError);
          notifyCloseRequested();
        }
      } else {
        await closeInternal().catch(options.onError);
        notifyCloseRequested();
      }
      throw error;
    }
  };

  const resetProfileInternal = async (): Promise<BrowserSessionStatus> => {
    if (!options.profilePath || !metadataFallback) {
      throw new Error("UNSUPPORTED_SESSION_CONTROL: reset_profile requires a managed --user-data-dir");
    }
    await closeRuntime();
    if (metadata?.ownership === "managed") {
      await stopManagedBrowser(metadata);
    }
    const resetResult = await backupAndResetProfile(options.profilePath, metadataFallback);
    syncFromMetadata(resetResult.metadata);
    lastBackupPath = resetResult.backupPath;
    notifyToolsetMayHaveChanged();
    if (options.authPolicy.mode === "bootstrap_then_attach") {
      return await bootstrapSessionInternal();
    }
    return refreshStatus();
  };

  const initializeControlPlane = async (): Promise<void> => {
    if (options.authPolicy.mode !== "bootstrap_then_attach") {
      const nextControlMode = configuredBrowserUrl ? "attach" : "launch";
      const nextRuntime = await options.runtimeFactory({
        controlMode: nextControlMode,
        preferredPresentationMode,
        ...(configuredBrowserUrl !== undefined ? { browserUrl: configuredBrowserUrl } : {}),
      });
      await activateRuntime(
        nextRuntime,
        nextControlMode === "attach" ? "external" : "managed",
        configuredBrowserUrl,
      );
      return;
    }

    const managedProfilePath = options.profilePath as string;
    metadata = await readSessionMetadata(managedProfilePath, metadataFallback as NonNullable<typeof metadataFallback>);
    syncFromMetadata(metadata);

    if (metadata.ownership === "managed" && metadata.controlMode === "attach") {
      const managedBrowserPid = metadata.browserPid ?? (await findBrowserProcessForProfile(managedProfilePath));
      if (managedBrowserPid && (await isOrphanedManagedBrowser(managedBrowserPid))) {
        await reapManagedBrowserProcess(managedBrowserPid, "BROWSER_CLOSE_TIMEOUT");
        await clearManagedBrowserMetadata();
      }
    }

    if (configuredBrowserUrl) {
      await attachSessionInternal(configuredBrowserUrl);
      return;
    }

    const hasRunningBootstrapExternal = await hasRunningBootstrapBrowser(metadata);
    if (hasRunningBootstrapExternal) {
      return;
    }

    const hasRunningManagedAttach =
      metadata.controlMode === "attach" &&
      metadata.browserUrl !== undefined &&
      metadata.ownership === "managed" &&
      (await isProcessRunning(metadata.browserPid));
    if (hasRunningManagedAttach) {
      await attachSessionInternal();
      return;
    }

    if (metadata.authState === "authenticated") {
      await attachSessionInternal();
      return;
    }

    if (metadata.sessionState !== "profile_missing") {
      await attachSessionInternal();
      return;
    }

    await bootstrapSessionInternal(
      metadata.authState === "auth_required" || metadata.authState === "challenge_required"
        ? metadata.authState
        : "unknown",
    );
  };

  const controller: BrowserSessionController<TRuntime> = {
    getState: refreshStatus,
    getRuntime: () => runtime,
    onResourceUpdated: (listener) => {
      resourceUpdatedListeners.add(listener);
      return () => {
        resourceUpdatedListeners.delete(listener);
      };
    },
    onToolsetMayHaveChanged: (listener) => {
      toolsetChangedListeners.add(listener);
      return () => {
        toolsetChangedListeners.delete(listener);
      };
    },
    openWindow: async () => {
      return await runLifecycleTransition(async () => {
        if (runtime) {
          return await runtime.openWindow();
        }
        if (options.authPolicy.mode === "bootstrap_then_attach") {
          if (await hasRunningBootstrapBrowser()) {
            await (options.focusBrowserWindow ?? focusBrowserWindow)(options.browserChannel).catch(() => {
              // Focusing an external browser is best-effort; reuse still avoids duplicate windows.
            });
            return "focused";
          }
          await bootstrapSessionInternal(authState);
          return "opened";
        }
        throw new Error("SESSION_NOT_AVAILABLE: current page is closed");
      });
    },
    bootstrapSession: async () => {
      return await runLifecycleTransition(async () => await bootstrapSessionInternal(authState));
    },
    attachSession: async (requestedBrowserUrl?: string) => {
      return await runLifecycleTransition(async () => await attachSessionInternal(requestedBrowserUrl));
    },
    getPresentationMode: () => refreshStatus().presentationMode,
    setPresentationMode: async (setModeOptions) =>
      await runLifecycleTransition(async () => await setPresentationModeInternal(setModeOptions)),
    resetProfile: async () => {
      return await runLifecycleTransition(async () => await resetProfileInternal());
    },
    close: async () => {
      await runLifecycleTransition(async () => {
        await closeInternal();
      });
    },
  };

  try {
    await initializeControlPlane();
    return controller;
  } catch (error) {
    await closeInternal().catch(options.onError);
    throw error;
  }
}
