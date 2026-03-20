/**
 * This module tests bridge lifecycle coordination between the stdio server and browser runtime.
 * It depends on mocked runtime/server modules so input-stream shutdown behavior remains deterministic.
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

let resolveOwnerSessionEnded = (): void => {};
function resetOwnerSessionEnded(): void {
  runtimeHandle.ownerSessionEnded = new Promise<void>((resolve) => {
    resolveOwnerSessionEnded = resolve;
  });
}

const runtimeHandle = {
  site: "board",
  targetUrl: "http://127.0.0.1:4173",
  controlMode: "launch" as const,
  mode: "native" as const,
  headless: false,
  gateway: {
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ ok: true })),
    listResources: vi.fn(async () => []),
    readResource: vi.fn(async () => ({ ok: true })),
    onResourceUpdated: vi.fn(() => () => {}),
  },
  openWindow: vi.fn(async () => "focused" as const),
  ownerSessionEnded: Promise.resolve(),
  close: vi.fn(async () => {}),
};

const serverHandle = {
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

vi.mock("../src/runtime.js", () => ({
  startLocalMcpRuntime: vi.fn(async () => runtimeHandle),
}));

vi.mock("../src/server.js", () => ({
  createLocalMcpStdioServer: vi.fn(() => serverHandle),
}));

describe("startLocalMcpBridge", () => {
  resetOwnerSessionEnded();

  afterEach(() => {
    resetOwnerSessionEnded();
    runtimeHandle.close.mockClear();
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
      expect(runtimeHandle.close).toHaveBeenCalledOnce();
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
      expect(runtimeHandle.close).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  it("closes resources when the runtime reports the owner window ended", async () => {
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
      expect(runtimeHandle.close).toHaveBeenCalledOnce();
    });
  });
});
