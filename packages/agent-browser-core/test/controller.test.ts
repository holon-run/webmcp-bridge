/**
 * This module tests browser session lifecycle orchestration inside agent-browser-core.
 * It depends on mocked session helpers and runtime factories so bootstrap, attach, mode-switch, and reset flows stay transport-agnostic.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import type { SessionMetadata } from "../src/session.js";

type MockRuntimeHandle = {
  controlMode: "launch" | "attach";
  mode: "native" | "polyfill" | "adapter-shim";
  presentationMode: "headed" | "headless";
  gateway: {
    callTool: ReturnType<typeof vi.fn>;
    onResourceUpdated: ReturnType<typeof vi.fn>;
  };
  openWindow: ReturnType<typeof vi.fn>;
  ownerSessionEnded: Promise<void>;
  close: ReturnType<typeof vi.fn>;
};

let mockSessionMetadata: SessionMetadata | undefined;
const runningPids = new Set<number>();

function createOwnerSessionEndedPromise(): Promise<void> {
  return new Promise<void>(() => {});
}

function createRuntimeHandle(
  overrides: Omit<Partial<MockRuntimeHandle>, "gateway"> & {
    gateway?: Partial<MockRuntimeHandle["gateway"]>;
  } = {},
): MockRuntimeHandle {
  const { gateway: gatewayOverrides, ...runtimeOverrides } = overrides;
  const gateway: MockRuntimeHandle["gateway"] = {
    callTool: vi.fn(async () => ({ state: "authenticated" })),
    onResourceUpdated: vi.fn(() => () => {}),
  };
  if (gatewayOverrides?.callTool) {
    gateway.callTool = gatewayOverrides.callTool;
  }
  if (gatewayOverrides?.onResourceUpdated) {
    gateway.onResourceUpdated = gatewayOverrides.onResourceUpdated;
  }
  return {
    controlMode: "attach",
    mode: "adapter-shim",
    presentationMode: "headed",
    gateway,
    openWindow: vi.fn(async () => "focused" as const),
    ownerSessionEnded: createOwnerSessionEndedPromise(),
    close: vi.fn(async () => {}),
    ...runtimeOverrides,
  };
}

let runtimeQueue: MockRuntimeHandle[] = [];

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
const readBrowserProcessMock = vi.fn(
  async (pid?: number) => (pid ? { pid, ppid: 2000, pgid: pid, command: `chrome --user-data-dir=/tmp/mock-profile` } : undefined),
);
const stopManagedBrowserMock = vi.fn(async () => {});
const backupAndResetProfileMock = vi.fn(
  async (
    _profileDir: string,
    fallback: {
      site: string;
      targetUrl: string;
      authPolicy: { mode: "none" | "bootstrap_then_attach"; authProbeTool?: string; allowAnonymousTools: boolean };
    },
  ) => {
    const metadata = {
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
      lastBackupPath: "/tmp/mock-profile-backup",
      updatedAt: new Date().toISOString(),
    } satisfies SessionMetadata;
    mockSessionMetadata = metadata;
    return {
      metadata,
      backupPath: "/tmp/mock-profile-backup",
    };
  },
);

vi.mock("../src/session.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session.js")>("../src/session.js");
  return {
    ...actual,
    ensureManagedProfile: vi.fn(async () => {}),
    readSessionMetadata: vi.fn(
      async (
        _profileDir: string,
        fallback: {
          site: string;
          targetUrl: string;
          authPolicy: { mode: "none" | "bootstrap_then_attach"; authProbeTool?: string; allowAnonymousTools: boolean };
        },
      ) => {
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
        } satisfies SessionMetadata;
      },
    ),
    updateSessionMetadata: vi.fn(
      async (
        _profileDir: string,
        fallback: {
          site: string;
          targetUrl: string;
          authPolicy: { mode: "none" | "bootstrap_then_attach"; authProbeTool?: string; allowAnonymousTools: boolean };
        },
        patch: Partial<SessionMetadata>,
      ) => {
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
        if ("lastBackupPath" in patch && patch.lastBackupPath === null) {
          delete next.lastBackupPath;
        }
        mockSessionMetadata = next;
        return next;
      },
    ),
    launchBootstrapBrowser: launchBootstrapBrowserMock,
    launchManagedAttachBrowser: launchManagedAttachBrowserMock,
    isProcessRunning: isProcessRunningMock,
    findBrowserProcessForProfile: findBrowserProcessForProfileMock,
    readBrowserProcess: readBrowserProcessMock,
    stopBrowserProcess: stopBrowserProcessMock,
    waitForProcessExit: waitForProcessExitMock,
    focusBrowserWindow: focusBrowserWindowMock,
    stopManagedBrowser: stopManagedBrowserMock,
    backupAndResetProfile: backupAndResetProfileMock,
  };
});

describe("startBrowserSessionController", () => {
  afterEach(() => {
    mockSessionMetadata = undefined;
    runningPids.clear();
    runtimeQueue = [];
    launchBootstrapBrowserMock.mockClear();
    launchManagedAttachBrowserMock.mockClear();
    isProcessRunningMock.mockClear();
    stopBrowserProcessMock.mockClear();
    waitForProcessExitMock.mockClear();
    focusBrowserWindowMock.mockClear();
    findBrowserProcessForProfileMock.mockClear();
    readBrowserProcessMock.mockClear();
    stopManagedBrowserMock.mockClear();
    backupAndResetProfileMock.mockClear();
  });

  it("preserves a running bootstrap browser as control-only state", async () => {
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

    const { startBrowserSessionController } = await import("../src/controller.js");
    const controller = await startBrowserSessionController({
      site: "x",
      targetUrl: "https://x.com/home",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      },
      profilePath: "/tmp/mock-profile",
      browserChannel: "chrome",
      runtimeFactory: async () => {
        throw new Error("runtimeFactory should not be called");
      },
    });

    expect(controller.getState()).toMatchObject({
      controlMode: "bootstrap",
      mode: "control-only",
      authState: "auth_required",
      ownership: "external",
      browserPid: 41001,
    });
    expect(launchBootstrapBrowserMock).not.toHaveBeenCalled();
  });

  it("auto-closes a bootstrap browser before launching managed attach", async () => {
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
    runtimeQueue = [
      createRuntimeHandle({
        controlMode: "attach",
        presentationMode: "headed",
        gateway: {
          callTool: vi.fn(async () => ({ state: "authenticated" })),
        },
      }),
    ];

    const { startBrowserSessionController } = await import("../src/controller.js");
    const controller = await startBrowserSessionController({
      site: "x",
      targetUrl: "https://x.com/home",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      },
      profilePath: "/tmp/mock-profile",
      browserChannel: "chrome",
      runtimeFactory: async () => {
        const nextHandle = runtimeQueue.shift();
        if (!nextHandle) {
          throw new Error("missing mocked runtime handle");
        }
        return nextHandle;
      },
    });

    const session = await controller.attachSession();

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41001);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41001, 5000);
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(session).toMatchObject({
      controlMode: "attach",
      browserUrl: "http://127.0.0.1:9333",
      ownership: "managed",
    });
  });

  it("relaunches a managed attach browser when switching presentation mode", async () => {
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
    runningPids.add(41002);
    runtimeQueue = [
      createRuntimeHandle({
        controlMode: "attach",
        presentationMode: "headed",
      }),
      createRuntimeHandle({
        controlMode: "attach",
        presentationMode: "headless",
      }),
    ];

    const { startBrowserSessionController } = await import("../src/controller.js");
    const controller = await startBrowserSessionController({
      site: "x",
      targetUrl: "https://x.com/home",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      },
      profilePath: "/tmp/mock-profile",
      browserChannel: "chrome",
      runtimeFactory: async () => {
        const nextHandle = runtimeQueue.shift();
        if (!nextHandle) {
          throw new Error("missing mocked runtime handle");
        }
        return nextHandle;
      },
    });

    const session = await controller.setPresentationMode({
      presentationMode: "headless",
    });

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41002);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41002, 5000);
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
      sessionState: "runtime_active",
    });
  });

  it("reaps an orphaned managed attach browser before restoring the session", async () => {
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
    runningPids.add(41002);
    readBrowserProcessMock.mockImplementationOnce(async (pid?: number) =>
      pid ? { pid, ppid: 1, pgid: pid, command: "chrome --user-data-dir=/tmp/mock-profile" } : undefined,
    );
    runtimeQueue = [
      createRuntimeHandle({
        controlMode: "attach",
        presentationMode: "headed",
        gateway: {
          callTool: vi.fn(async () => ({ state: "authenticated" })),
        },
      }),
    ];

    const { startBrowserSessionController } = await import("../src/controller.js");
    const controller = await startBrowserSessionController({
      site: "x",
      targetUrl: "https://x.com/home",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      },
      profilePath: "/tmp/mock-profile",
      browserChannel: "chrome",
      runtimeFactory: async () => {
        const nextHandle = runtimeQueue.shift();
        if (!nextHandle) {
          throw new Error("missing mocked runtime handle");
        }
        return nextHandle;
      },
    });

    expect(stopBrowserProcessMock).toHaveBeenCalledWith(41002);
    expect(waitForProcessExitMock).toHaveBeenCalledWith(41002, 5000);
    expect(launchManagedAttachBrowserMock).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9333",
      browserPid: 41002,
    });
  });

  it("resets a managed profile and returns to bootstrap mode", async () => {
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
    runtimeQueue = [createRuntimeHandle({ controlMode: "attach", presentationMode: "headed" })];

    const { startBrowserSessionController } = await import("../src/controller.js");
    const controller = await startBrowserSessionController({
      site: "x",
      targetUrl: "https://x.com/home",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      },
      profilePath: "/tmp/mock-profile",
      browserChannel: "chrome",
      runtimeFactory: async () => {
        const nextHandle = runtimeQueue.shift();
        if (!nextHandle) {
          throw new Error("missing mocked runtime handle");
        }
        return nextHandle;
      },
    });

    const session = await controller.resetProfile();

    expect(backupAndResetProfileMock).toHaveBeenCalledOnce();
    expect(stopManagedBrowserMock).toHaveBeenCalledOnce();
    expect(launchBootstrapBrowserMock).toHaveBeenCalledOnce();
    expect(session).toMatchObject({
      controlMode: "bootstrap",
      mode: "control-only",
      ownership: "external",
      browserPid: 41001,
      lastBackupPath: "/tmp/mock-profile-backup",
    });
  });
});
