/**
 * This module tests Playwright page gateway behavior using page-like mocks.
 * It depends on gateway APIs to validate mode detection, tool listing, and adapter lifecycle wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { createWebMcpPageGateway } from "../src/index.js";

function createMockPage(mode: "native" | "shim", tools: unknown[] = []) {
  const listeners = new Map<string, Array<() => void>>();
  let noArgFunctionCallCount = 0;
  const page = {
    addInitScript: vi.fn(async () => {}),
    exposeFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async (script: string | ((...args: unknown[]) => unknown), payload?: unknown) => {
      if (typeof script !== "function") {
        return undefined;
      }
      if (
        payload &&
        typeof payload === "object" &&
        "callName" in payload &&
        typeof (payload as { callName?: unknown }).callName === "string"
      ) {
        return { ok: true, name: (payload as { callName: string }).callName };
      }
      noArgFunctionCallCount += 1;
      if (noArgFunctionCallCount === 1) {
        return mode;
      }
      return tools;
    }),
    on: vi.fn((event: string, callback: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(callback);
      listeners.set(event, list);
    }),
    removeListener: vi.fn((event: string, callback: () => void) => {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((item) => item !== callback),
      );
    }),
  };
  return { page };
}

describe("createWebMcpPageGateway", () => {
  it("uses fallback adapter tool listing in shim mode", async () => {
    const { page } = createMockPage("shim", [{ name: "native.tool" }]);
    const adapter = {
      name: "x",
      listTools: vi.fn(async () => [{ name: "x.health", description: "health" }]),
      callTool: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const gateway = await createWebMcpPageGateway(page as never, { fallbackAdapter: adapter });
    expect(gateway.mode).toBe("shim");
    expect(adapter.start).toHaveBeenCalledOnce();
    expect((await gateway.listTools()).map((tool) => tool.name)).toEqual(["x.health"]);
    expect(adapter.listTools).toHaveBeenCalledOnce();

    await gateway.close();
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("uses native list when native mode is available", async () => {
    const { page } = createMockPage("native", [{ name: "native.health" }]);

    const gateway = await createWebMcpPageGateway(page as never);
    expect(gateway.mode).toBe("native");
    expect((await gateway.listTools()).map((tool) => tool.name)).toEqual(["native.health"]);
    await expect(gateway.callTool("native.health", {})).resolves.toEqual({
      ok: true,
      name: "native.health",
    });
  });
});
