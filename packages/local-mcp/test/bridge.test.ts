/**
 * This module tests bridge lifecycle coordination between the stdio server and browser runtime.
 * It depends on mocked runtime/server modules so bridge-level session restarts keep the MCP server alive while swapping runtimes.
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalMcpStdioServerOptions } from "../src/server.js";
import type { SessionMetadata } from "../src/session.js";

type MockRuntimeHandle = {
  site: string;
  targetUrl: string;
  controlMode: "launch" | "attach";
  mode: "native" | "polyfill" | "adapter-shim";
  presentationMode: "headed" | "headless";
  gateway: {
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    listResources: ReturnType<typeof vi.fn>;
    readResource: ReturnType<typeof vi.fn>;
    onResourceUpdated: ReturnType<typeof vi.fn>;
  };
  openWindow: ReturnType<typeof vi.fn>;
  ownerSessionEnded: Promise<void>;
  close: ReturnType<typeof vi.fn>;
};

let capturedServerOptions: LocalMcpStdioServerOptions | undefined;
let resolveOwnerSessionEnded = (): void => {};
let mockSessionMetadata: SessionMetadata | undefined;
const runningPids = new Set<number>();

function createOwnerSessionEndedPromise(): Promise<void> {
  return new Promise<void>((resolve) => {
    resolveOwnerSessionEnded = resolve;
  });
}

function createRuntimeHandle(
  overrides: Omit<Partial<MockRuntimeHandle>, "gateway"> & {
    gateway?: Partial<MockRuntimeHandle["gateway"]>;
  } = {},
): MockRuntimeHandle {
  const { gateway: gatewayOverrides, ...runtimeOverrides } = overrides;
  const gateway: MockRuntimeHandle["gateway"] = {
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ ok: true })),
    listResources: vi.fn(async () => []),
    readResource: vi.fn(async () => ({ ok: true })),
    onResourceUpdated: vi.fn(() => () => {}),
  };
  if (gatewayOverrides?.listTools) {
    gateway.listTools = gatewayOverrides.listTools;
  }
  if (gatewayOverrides?.callTool) {
    gateway.callTool = gatewayOverrides.callTool;
  }
  if (gatewayOverrides?.listResources) {
    gateway.listResources = gatewayOverrides.listResources;
  }
  if (gatewayOverrides?.readResource) {
    gateway.readResource = gatewayOverrides.readResource;
  }
  if (gatewayOverrides?.onResourceUpdated) {
    gateway.onResourceUpdated = gatewayOverrides.onResourceUpdated;
  }
  return {
    site: "board",
    targetUrl: "http://127.0.0.1:4173",
    controlMode: "launch",
    mode: "native",
    presentationMode: "headed",
    gateway,
    openWindow: vi.fn(async () => "focused" as const),
    ownerSessionEnded: createOwnerSessionEndedPromise(),
    close: vi.fn(async () => {}),
    ...runtimeOverrides,
  };
}

let runtimeQueue: MockRuntimeHandle[] = [createRuntimeHandle()];
let startedRuntimeHandles: MockRuntimeHandle[] = [];
const resolveCdpConnectUrlMock = vi.fn(async (browserUrl: string) => browserUrl);

const serverHandle = {
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

const launchBootstrapBrowserMock = vi.fn(async () => ({ pid: 41001 }));
const launchManagedAttachBrowserMock = vi.fn(async () => ({
  browserUrl: "http://127.0.0.1:9333",
  pid: 41002,
}));
const isProcessRunningMock = vi.fn(async (pid?: number) => (pid ? runningPids.has(pid) : false));
const stopBrowserProcessMock = vi.fn(async (pid?: number) => {
  if (pid) {
    runningPids.delete(pid);
  }
});
const waitForProcessExitMock = vi.fn(async (pid?: number) => (pid ? !runningPids.has(pid) : true));
const focusBrowserWindowMock = vi.fn(async () => true);
const findBrowserProcessForProfileMock = vi.fn(async () => undefined as number | undefined);
const stopManagedBrowserMock = vi.fn(async () => {});

vi.mock("../src/runtime.js", () => ({
  startLocalMcpRuntime: vi.fn(async () => {
    const nextHandle = runtimeQueue.shift();
    if (!nextHandle) {
      throw new Error("missing mocked runtime handle");
    }
    startedRuntimeHandles.push(nextHandle);
    return nextHandle;
  }),
  resolveCdpConnectUrl: resolveCdpConnectUrlMock,
}));

vi.mock("../src/server.js", () => ({
  createLocalMcpStdioServer: vi.fn((options: LocalMcpStdioServerOptions) => {
    capturedServerOptions = options;
    return serverHandle;
  }),
}));

vi.mock("../src/sites.js", () => ({
  createNativeSiteDefinition: vi.fn((url: string) => ({
    id: "native",
    source: "native",
    manifest: {
      id: "native",
      displayName: "Native",
      version: "0.1.0",
      bridgeApiVersion: "1.0.0",
      defaultUrl: url,
      hostPatterns: ["*"],
      authPolicy: {
        mode: "none",
      },
    },
  })),
  resolveSiteSource: vi.fn(async (options: { site?: string }) => {
    if (options.site === "x") {
      return {
        id: "x",
        source: "builtin",
        manifest: {
          id: "x.com",
          displayName: "X",
          version: "0.5.0",
          bridgeApiVersion: "1.0.0",
          defaultUrl: "https://x.com/home",
          hostPatterns: ["x.com"],
          authPolicy: {
            mode: "bootstrap_then_attach",
            authProbeTool: "auth.get",
            allowAnonymousTools: true,
          },
        },
      };
    }
    if (options.site === "weibo") {
      return {
        id: "weibo",
        source: "builtin",
        manifest: {
          id: "weibo.com",
          displayName: "Weibo",
          version: "0.5.0",
          bridgeApiVersion: "1.0.0",
          defaultUrl: "https://weibo.com",
          hostPatterns: ["weibo.com", "*.weibo.com"],
          authPolicy: {
            mode: "bootstrap_then_attach",
            authProbeTool: "auth.get",
            allowAnonymousTools: true,
          },
        },
      };
    }
    throw new Error(`unsupported mocked site: ${String(options.site)}`);
  }),
}));

vi.mock("../src/session.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session.js")>("../src/session.js");
  return {
    ...actual,
    assertAuthSensitiveBrowserSupport: vi.fn(() => {}),
    ensureManagedProfile: vi.fn(async () => {}),
    readSessionMetadata: vi.fn(async (_profileDir: string, fallback: { site: string; targetUrl: string; authPolicy: { mode: "none" | "bootstrap_then_attach"; authProbeTool?: string; allowAnonymousTools: boolean } }) => {
      if (mockSessionMetadata) {
        return mockSessionMetadata;
      }
      return {
        version: 2,
        site: fallback.site,
        profilePath: "/tmp/mock-profile",
        targetUrl: fallback.targetUrl,
        authPolicyMode: fallback.authPolicy.mode,
        ...(fallback.authPolicy.authProbeTool ? { authProbeTool: fallback.authPolicy.authProbeTool } : {}),
        allowAnonymousTools: fallback.authPolicy.allowAnonymousTools,
        presentationMode: "headed",
        preferredPresentationMode: "headed",
        sessionState: "profile_missing",
        authState: "unknown",
        controlMode: "none",
        ownership: "none",
        updatedAt: new Date().toISOString(),
      };
    }),
    updateSessionMetadata: vi.fn(async (_profileDir: string, fallback: { site: string; targetUrl: string; authPolicy: { mode: "none" | "bootstrap_then_attach"; authProbeTool?: string; allowAnonymousTools: boolean } }, patch: Partial<SessionMetadata>) => {
      const current =
        mockSessionMetadata ??
        ({
          version: 2,
          site: fallback.site,
          profilePath: "/tmp/mock-profile",
          targetUrl: fallback.targetUrl,
          authPolicyMode: fallback.authPolicy.mode,
          ...(fallback.authPolicy.authProbeTool ? { authProbeTool: fallback.authPolicy.authProbeTool } : {}),
          allowAnonymousTools: fallback.authPolicy.allowAnonymousTools,
          presentationMode: "headed",
          preferredPresentationMode: "headed",
          sessionState: "profile_missing",
          authState: "unknown",
          controlMode: "none",
          ownership: "none",
          updatedAt: new Date().toISOString(),
        } satisfies SessionMetadata);
      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      } as SessionMetadata;
      if ("browserUrl" in patch && patch.browserUrl === null) {
        delete next.browserUrl;
      }
      if ("browserPid" in patch && patch.browserPid === null) {
        delete next.browserPid;
      }
      mockSessionMetadata = next;
      return next;
    }),
    launchBootstrapBrowser: launchBootstrapBrowserMock,
    launchManagedAttachBrowser: launchManagedAttachBrowserMock,
    isProcessRunning: isProcessRunningMock,
    findBrowserProcessForProfile: findBrowserProcessForProfileMock,
    stopBrowserProcess: stopBrowserProcessMock,
    waitForProcessExit: waitForProcessExitMock,
    focusBrowserWindow: focusBrowserWindowMock,
    stopManagedBrowser: stopManagedBrowserMock,
  };
});

describe("startLocalMcpBridge", () => {
  afterEach(() => {
    capturedServerOptions = undefined;
    mockSessionMetadata = undefined;
    runningPids.clear();
    runtimeQueue = [createRuntimeHandle()];
    startedRuntimeHandles = [];
    resolveCdpConnectUrlMock.mockReset();
    resolveCdpConnectUrlMock.mockImplementation(async (browserUrl: string) => browserUrl);
    serverHandle.start.mockClear();
    serverHandle.close.mockClear();
    launchBootstrapBrowserMock.mockClear();
    launchManagedAttachBrowserMock.mockClear();
    isProcessRunningMock.mockClear();
    stopBrowserProcessMock.mockClear();
    waitForProcessExitMock.mockClear();
    focusBrowserWindowMock.mockClear();
    findBrowserProcessForProfileMock.mockClear();
    stopManagedBrowserMock.mockClear();
  });

  it("closes runtime when stdio input ends", async () => {
    const { startLocalMcpBridge } = await import("../src/bridge.js");
    const input = new PassThrough();

    const handle = await startLocalMcpBridge({
      url: "http://127.0.0.1:4173",
      serviceVersion: "0.1.0-test",
      input,
    });

    input.emit("end");
    await vi.waitFor(() => {
      expect(serverHandle.close).toHaveBeenCalledOnce();
      expect(startedRuntimeHandles[0]?.close).toHaveBeenCalledOnce();
    });

    expect(serverHandle.start).toHaveBeenCalledOnce();

    await handle.close();
  });

  it("still closes the runtime when server cleanup fails", async () => {
    serverHandle.close.mockImplementationOnce(async () => {
      throw new Error("server close failed");
    });
    const onError = vi.fn();
    const { startLocalMcpBridge } = await import("../src/bridge.js");
    const input = new PassThrough();

    await startLocalMcpBridge({
      url: "http://127.0.0.1:4173",
      serviceVersion: "0.1.0-test",
      input,
      onError,
    });

    input.emit("end");
    await vi.waitFor(() => {
      expect(startedRuntimeHandles[0]?.close).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  it("closes resources when the active runtime reports the owner window ended", async () => {
    const { startLocalMcpBridge } = await import("../src/bridge.js");
    const input = new PassThrough();

    await startLocalMcpBridge({
      url: "http://127.0.0.1:4173",
      serviceVersion: "0.1.0-test",
      input,
    });

    resolveOwnerSessionEnded();
    await vi.waitFor(() => {
      expect(serverHandle.close).toHaveBeenCalledOnce();
      expect(startedRuntimeHandles[0]?.close).toHaveBeenCalledOnce();
    });
  });

  it("restarts the active runtime in attach mode and updates the gateway proxy", async () => {
    const launchRuntime = createRuntimeHandle();
    const attachRuntime = createRuntimeHandle({
      controlMode: "attach",
      gateway: {
        listTools: vi.fn(async () => [{ name: "attached-tool" }]),
        callTool: vi.fn(async () => ({ ok: true, mode: "attach" })),
      },
    });
    runtimeQueue = [launchRuntime, attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      url: "http://127.0.0.1:4173",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    const session = await capturedServerOptions?.bridgeControl.attachSession("http://127.0.0.1:9222");

    expect(launchRuntime.close).toHaveBeenCalledOnce();
    expect(session).toMatchObject({
      controlMode: "attach",
      browserUrl: "http://127.0.0.1:9222",
    });
    await expect(capturedServerOptions?.gateway.listTools()).resolves.toEqual([{ name: "attached-tool" }]);
    await expect(capturedServerOptions?.gateway.callTool("ping", {})).resolves.toEqual({
      ok: true,
      mode: "attach",
    });
  });

  it("starts builtin weibo and exposes adapter-backed tools through the gateway proxy", async () => {
    const weiboRuntime = createRuntimeHandle({
      site: "weibo",
      targetUrl: "https://weibo.com",
      mode: "adapter-shim",
      gateway: {
        listTools: vi.fn(async () => [
          { name: "auth.get", inputSchema: { type: "object" } },
          { name: "search.ai.summary", inputSchema: { type: "object" } },
        ]),
        callTool: vi.fn(async (name: string, input: Record<string, unknown>) => ({
          name,
          input,
          source: "network",
        })),
      },
    });
    mockSessionMetadata = {
      version: 2,
      site: "weibo",
      profilePath: "/tmp/mock-weibo-profile",
      targetUrl: "https://weibo.com",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "authenticated",
      authState: "authenticated",
      controlMode: "none",
      ownership: "none",
      updatedAt: new Date().toISOString(),
    };
    runtimeQueue = [weiboRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "weibo",
      userDataDir: "/tmp/mock-weibo-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(startedRuntimeHandles[0]?.site).toBe("weibo");
    expect(startedRuntimeHandles[0]?.targetUrl).toBe("https://weibo.com");
    await expect(capturedServerOptions?.gateway.listTools()).resolves.toEqual([
      { name: "auth.get", inputSchema: { type: "object" } },
      { name: "search.ai.summary", inputSchema: { type: "object" } },
    ]);
    await expect(
      capturedServerOptions?.gateway.callTool("search.ai.summary", { query: "OpenAI" }),
    ).resolves.toEqual({
      name: "search.ai.summary",
      input: { query: "OpenAI" },
      source: "network",
    });
    expect(weiboRuntime.gateway.callTool).toHaveBeenCalledWith("search.ai.summary", { query: "OpenAI" });
  });

  it("fails closed when attach startup and recovery both fail", async () => {
    const launchRuntime = createRuntimeHandle();
    runtimeQueue = [launchRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      url: "http://127.0.0.1:4173",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    await expect(capturedServerOptions?.bridgeControl.attachSession("http://127.0.0.1:9222")).rejects.toThrow(
      "missing mocked runtime handle",
    );
    await vi.waitFor(() => {
      expect(serverHandle.close).toHaveBeenCalledOnce();
    });
    await expect(
      capturedServerOptions?.bridgeControl.setPresentationMode({ presentationMode: "headed" }),
    ).rejects.toThrow(
      "SESSION_NOT_AVAILABLE: local-mcp bridge session is closed",
    );
  });

  it("rejects attach-incompatible browser channel configuration before runtime startup", async () => {
    const { startLocalMcpBridge } = await import("../src/bridge.js");

    await expect(
      startLocalMcpBridge({
        url: "http://127.0.0.1:4173",
        browserUrl: "http://127.0.0.1:9222",
        browserChannel: "chrome",
        serviceVersion: "0.1.0-test",
        input: new PassThrough(),
      }),
    ).rejects.toThrow("CONFIG_ERROR: --browser-url cannot be combined with --browser-channel");
  });

  it("keeps auth-sensitive bridges in control-only mode when a bootstrap browser is already running", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "auth_required",
      authState: "auth_required",
      controlMode: "bootstrap",
      ownership: "external",
      browserPid: 41001,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41001);

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(startedRuntimeHandles).toHaveLength(0);
    expect(launchBootstrapBrowserMock).not.toHaveBeenCalled();
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      controlMode: "bootstrap",
      mode: "control-only",
      authState: "auth_required",
      ownership: "external",
      browserPid: 41001,
    });
  });

  it("reuses the running bootstrap browser for bridge.window.open", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "auth_required",
      authState: "auth_required",
      controlMode: "bootstrap",
      ownership: "external",
      browserPid: 41001,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41001);

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    await expect(capturedServerOptions?.bridgeControl.openWindow()).resolves.toBe("focused");
    expect(focusBrowserWindowMock).toHaveBeenCalledWith("chrome");
    expect(launchBootstrapBrowserMock).not.toHaveBeenCalled();
  });

  it("auto-closes the tracked bootstrap browser before launching managed attach", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "authenticated",
      authState: "authenticated",
      controlMode: "bootstrap",
      ownership: "external",
      browserPid: 41001,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41001);
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    const session = await capturedServerOptions?.bridgeControl.attachSession();

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41001);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41001, 5000);
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(launchManagedAttachBrowserMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      stopBrowserProcessMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(session).toMatchObject({
      controlMode: "attach",
      browserUrl: "http://127.0.0.1:9333",
      ownership: "managed",
    });
  });

  it("reuses a headed managed attach browser as bootstrap when auth is still required", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "authenticated",
      authState: "authenticated",
      controlMode: "none",
      ownership: "none",
      updatedAt: new Date().toISOString(),
    };
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      mode: "adapter-shim",
      presentationMode: "headed",
      gateway: {
        callTool: vi.fn(async () => ({ state: "auth_required" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(launchBootstrapBrowserMock).not.toHaveBeenCalled();
    expect(attachRuntime.close).toHaveBeenCalledOnce();
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      controlMode: "bootstrap",
      mode: "control-only",
      ownership: "external",
      browserPid: 41002,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      authState: "auth_required",
      sessionState: "auth_required",
    });
  });

  it("cleans up an existing managed browser for the profile before relaunching attach", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "profile_present_unverified",
      authState: "unknown",
      controlMode: "none",
      ownership: "none",
      updatedAt: new Date().toISOString(),
    };
    findBrowserProcessForProfileMock.mockResolvedValueOnce(41003);
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      presentationMode: "headed",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41003);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41003, 5000);
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      controlMode: "attach",
      ownership: "managed",
      presentationMode: "headed",
      authState: "authenticated",
      sessionState: "runtime_active",
    });
  });

  it("fails attach when the bootstrap browser does not exit", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "authenticated",
      authState: "authenticated",
      controlMode: "bootstrap",
      ownership: "external",
      browserPid: 41001,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41001);
    waitForProcessExitMock.mockResolvedValueOnce(false);

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    await expect(capturedServerOptions?.bridgeControl.attachSession()).rejects.toThrow(
      "BOOTSTRAP_BROWSER_CLOSE_TIMEOUT",
    );
    expect(launchManagedAttachBrowserMock).not.toHaveBeenCalled();
  });

  it("discovers a live bootstrap browser by profile when the stored pid is stale", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "auth_required",
      authState: "auth_required",
      controlMode: "bootstrap",
      ownership: "external",
      browserPid: 41001,
      updatedAt: new Date().toISOString(),
    };
    findBrowserProcessForProfileMock.mockResolvedValueOnce(41002);

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(launchBootstrapBrowserMock).not.toHaveBeenCalled();
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      browserPid: 41002,
      controlMode: "bootstrap",
      mode: "control-only",
    });
  });

  it("tries managed attach before bootstrap when an auth-sensitive profile already exists", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headless",
      sessionState: "profile_present_unverified",
      authState: "unknown",
      controlMode: "none",
      ownership: "none",
      updatedAt: new Date().toISOString(),
    };
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      mode: "adapter-shim",
      presentationMode: "headless",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(launchBootstrapBrowserMock).not.toHaveBeenCalled();
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      controlMode: "attach",
      mode: "adapter-shim",
      ownership: "managed",
      presentationMode: "headless",
      preferredPresentationMode: "headless",
      authState: "authenticated",
      sessionState: "runtime_active",
    });
  });

  it("preserves managed ownership when restoring a running managed attach session from metadata", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headless",
      preferredPresentationMode: "headless",
      sessionState: "runtime_active",
      authState: "authenticated",
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9333",
      browserPid: 41002,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41002);
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      presentationMode: "headless",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(launchManagedAttachBrowserMock).not.toHaveBeenCalled();
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9333",
      presentationMode: "headless",
      preferredPresentationMode: "headless",
      authState: "authenticated",
      sessionState: "runtime_active",
    });
  });

  it("relaunches managed attach when persisted metadata points to a stale browser URL", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "runtime_active",
      authState: "authenticated",
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:54415",
      browserPid: 41002,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41002);
    resolveCdpConnectUrlMock.mockRejectedValueOnce(
      new Error("INVALID_BROWSER_URL: failed to query DevTools version at http://127.0.0.1:54415/json/version"),
    );
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      presentationMode: "headed",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      preferredPresentationMode: "headless",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41002);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41002, 5000);
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledWith({
      targetUrl: "https://x.com/home",
      userDataDir: "/tmp/mock-profile",
      presentationMode: "headless",
      browserChannel: "chrome",
    });
    expect(capturedServerOptions?.bridgeControl.getState()).toMatchObject({
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9333",
      preferredPresentationMode: "headless",
      sessionState: "runtime_active",
      authState: "authenticated",
    });
  });

  it("stops a managed attach browser when the bridge closes", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headless",
      preferredPresentationMode: "headless",
      sessionState: "runtime_active",
      authState: "authenticated",
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9333",
      browserPid: 41002,
      updatedAt: new Date().toISOString(),
    };
    runningPids.add(41002);
    const attachRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      presentationMode: "headless",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [attachRuntime];
    startedRuntimeHandles = [];

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    const handle = await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    await handle.close();

    expect(attachRuntime.close).toHaveBeenCalledOnce();
    expect(stopManagedBrowserMock).toHaveBeenCalledOnce();
    expect(stopManagedBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownership: "managed",
        browserPid: 41002,
        profilePath: "/tmp/mock-profile",
      }),
    );
  });

  it("relaunches managed attach browsers when switching presentation mode", async () => {
    mockSessionMetadata = {
      version: 2,
      site: "x",
      profilePath: "/tmp/mock-profile",
      targetUrl: "https://x.com/home",
      authPolicyMode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      sessionState: "runtime_active",
      authState: "authenticated",
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9222",
      browserPid: 41002,
      updatedAt: new Date().toISOString(),
    };
    const initialRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      presentationMode: "headed",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    const relaunchedRuntime = createRuntimeHandle({
      site: "x",
      targetUrl: "https://x.com/home",
      controlMode: "attach",
      presentationMode: "headless",
      gateway: {
        callTool: vi.fn(async () => ({ state: "authenticated" })),
      },
    });
    runtimeQueue = [initialRuntime, relaunchedRuntime];
    startedRuntimeHandles = [];
    runningPids.add(41002);

    const { startLocalMcpBridge } = await import("../src/bridge.js");
    await startLocalMcpBridge({
      site: "x",
      browserChannel: "chrome",
      userDataDir: "/tmp/mock-profile",
      serviceVersion: "0.1.0-test",
      input: new PassThrough(),
    });

    const session = await capturedServerOptions?.bridgeControl.setPresentationMode({
      presentationMode: "headless",
    });

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41002);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41002, 5000);
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledWith({
      targetUrl: "https://x.com/home",
      userDataDir: "/tmp/mock-profile",
      presentationMode: "headless",
      browserChannel: "chrome",
    });
    expect(session).toMatchObject({
      controlMode: "attach",
      ownership: "managed",
      presentationMode: "headless",
      preferredPresentationMode: "headless",
      authState: "authenticated",
      sessionState: "runtime_active",
    });
  });
});
