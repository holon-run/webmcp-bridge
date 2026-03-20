/**
 * This module tests bridge lifecycle coordination between the stdio server and browser runtime.
 * It depends on mocked runtime/server modules so bridge-level session restarts keep the MCP server alive while swapping runtimes.
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalMcpStdioServerOptions } from "../src/server.js";

type MockRuntimeHandle = {
  site: string;
  targetUrl: string;
  controlMode: "launch" | "attach";
  mode: "native" | "polyfill" | "adapter-shim";
  headless: boolean;
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
    headless: false,
    gateway,
    openWindow: vi.fn(async () => "focused" as const),
    ownerSessionEnded: createOwnerSessionEndedPromise(),
    close: vi.fn(async () => {}),
    ...runtimeOverrides,
  };
}

let runtimeQueue: MockRuntimeHandle[] = [createRuntimeHandle()];
let startedRuntimeHandles: MockRuntimeHandle[] = [];

const serverHandle = {
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

vi.mock("../src/runtime.js", () => ({
  startLocalMcpRuntime: vi.fn(async () => {
    const nextHandle = runtimeQueue.shift();
    if (!nextHandle) {
      throw new Error("missing mocked runtime handle");
    }
    startedRuntimeHandles.push(nextHandle);
    return nextHandle;
  }),
}));

vi.mock("../src/server.js", () => ({
  createLocalMcpStdioServer: vi.fn((options: LocalMcpStdioServerOptions) => {
    capturedServerOptions = options;
    return serverHandle;
  }),
}));

describe("startLocalMcpBridge", () => {
  afterEach(() => {
    capturedServerOptions = undefined;
    runtimeQueue = [createRuntimeHandle()];
    startedRuntimeHandles = [];
    serverHandle.start.mockClear();
    serverHandle.close.mockClear();
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
});
