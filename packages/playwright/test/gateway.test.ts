/**
 * This module tests Playwright page gateway behavior using page-like mocks.
 * It depends on gateway APIs to validate mode detection, tool listing, and adapter lifecycle wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { createWebMcpPageGateway } from "../src/index.js";

function createMockPage(mode: "native" | "polyfill", tools: unknown[] = []) {
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
  it("uses fallback adapter tool listing in adapter-shim mode", async () => {
    const { page } = createMockPage("polyfill", [{ name: "native.tool" }]);
    const adapter = {
      name: "x",
      listTools: vi.fn(async () => [{ name: "ping", description: "ping" }]),
      callTool: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const gateway = await createWebMcpPageGateway(page as never, { fallbackAdapter: adapter });
    expect(gateway.mode).toBe("adapter-shim");
    expect(adapter.start).toHaveBeenCalledOnce();
    expect((await gateway.listTools()).map((tool) => tool.name)).toEqual(["ping"]);
    expect(adapter.listTools).toHaveBeenCalledOnce();

    await gateway.close();
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("uses native list when native mode is available", async () => {
    const { page } = createMockPage("native", [{ name: "native.ping" }]);

    const gateway = await createWebMcpPageGateway(page as never);
    expect(gateway.mode).toBe("native");
    expect((await gateway.listTools()).map((tool) => tool.name)).toEqual(["native.ping"]);
    await expect(gateway.callTool("native.ping", {})).resolves.toEqual({
      ok: true,
      name: "native.ping",
    });
  });

  it("uses page registered tools in polyfill mode without adapter", async () => {
    const { page } = createMockPage("polyfill", [{ name: "site.tool" }]);
    const gateway = await createWebMcpPageGateway(page as never);
    expect(gateway.mode).toBe("polyfill");
    expect((await gateway.listTools()).map((tool) => tool.name)).toEqual(["site.tool"]);
    await expect(gateway.callTool("site.tool", {})).resolves.toEqual({
      ok: true,
      name: "site.tool",
    });
  });
});
