/**
 * This module tests Playwright page gateway behavior using page-like mocks.
 * It depends on gateway APIs to validate mode detection, tool listing, and adapter lifecycle wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { createWebMcpPageGateway } from "../src/index.js";

function createMockPage(
  mode: "native" | "polyfill",
  tools: unknown[] = [],
  resources: unknown[] = [],
) {
  const listeners = new Map<string, Array<() => void>>();
  const exposedFunctions = new Map<string, (...args: unknown[]) => unknown>();
  const page = {
    addInitScript: vi.fn<(...args: [string]) => Promise<void>>(async () => {}),
    exposeFunction: vi.fn<(...args: [string, (...args: unknown[]) => unknown]) => Promise<void>>(
      async (name: string, fn: (...args: unknown[]) => unknown) => {
        exposedFunctions.set(name, fn);
      },
    ),
    evaluate: vi.fn(async (script: string | ((...args: unknown[]) => unknown), payload?: unknown) => {
      if (typeof script !== "function") {
        return undefined;
      }
      const source = script.toString();
      if (
        payload &&
        typeof payload === "object" &&
        "callName" in payload &&
        typeof (payload as { callName?: unknown }).callName === "string"
      ) {
        return { ok: true, name: (payload as { callName: string }).callName };
      }
      if (
        payload &&
        typeof payload === "object" &&
        "resourceUri" in payload &&
        typeof (payload as { resourceUri?: unknown }).resourceUri === "string"
      ) {
        return {
          uri: (payload as { resourceUri: string }).resourceUri,
          ok: true,
        };
      }
      if (source.includes("__WEBMCP_BRIDGE_MODE__")) {
        return mode;
      }
      if (source.includes("listResources")) {
        return resources;
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
  return { page, exposedFunctions };
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

  it("lists and reads resources from page-hosted providers", async () => {
    const { page } = createMockPage(
      "polyfill",
      [{ name: "site.tool" }],
      [{ uri: "board://local/interactions", name: "Board Interactions" }],
    );
    const gateway = await createWebMcpPageGateway(page as never);

    await expect(gateway.listResources()).resolves.toEqual([
      { uri: "board://local/interactions", name: "Board Interactions" },
    ]);
    await expect(gateway.readResource("board://local/interactions")).resolves.toEqual({
      uri: "board://local/interactions",
      ok: true,
    });
  });

  it("forwards page resource updates to gateway listeners", async () => {
    const { page, exposedFunctions } = createMockPage("polyfill", []);
    const gateway = await createWebMcpPageGateway(page as never);
    const listener = vi.fn();
    const unsubscribe = gateway.onResourceUpdated(listener);

    const resourceUpdatedHandler = [...exposedFunctions.entries()].find(([name]) =>
      name.startsWith("__WEBMCP_BRIDGE_NOTIFY_RESOURCE_UPDATED__"),
    )?.[1];
    expect(resourceUpdatedHandler).toBeTypeOf("function");

    await resourceUpdatedHandler?.("board://local/interactions");
    expect(listener).toHaveBeenCalledWith("board://local/interactions");

    unsubscribe();
    await resourceUpdatedHandler?.("board://local/interactions");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("injects polyfill listTools support for page-hosted providers", async () => {
    const { page } = createMockPage("polyfill", []);
    await createWebMcpPageGateway(page as never);

    const initScripts = page.addInitScript.mock.calls.map(([script]) => String(script));
    expect(initScripts.some((script) => script.includes("listTools: async"))).toBe(true);
    expect(initScripts.some((script) => script.includes("listResources: async"))).toBe(true);
    expect(initScripts.some((script) => script.includes("globalAny.__webmcpBridge ="))).toBe(true);
  });
});
