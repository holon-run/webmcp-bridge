/**
 * This module tests Playwright bridge attach/detach behavior using page-like mocks.
 * It depends on attach APIs to validate injection and adapter callback wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { attachBridge, detachBridge } from "../src/index.js";

function createMockPage() {
  const listeners = new Map<string, Array<() => void>>();
  const exposed = new Map<string, (...args: unknown[]) => unknown>();
  const page = {
    addInitScript: vi.fn(async () => {}),
    exposeFunction: vi.fn(async (name: string, fn: (...args: unknown[]) => unknown) => {
      exposed.set(name, fn);
    }),
    evaluate: vi.fn(async (script: string | (() => unknown)) => {
      if (typeof script === "function") {
        return "shim";
      }
      if (script.includes("__WEBMCP_BRIDGE_MODE__")) {
        return "shim";
      }
      return undefined;
    }),
    on: vi.fn((event: string, callback: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(callback);
      listeners.set(event, list);
    }),
    removeAllListeners: vi.fn((event: string) => {
      listeners.delete(event);
    }),
  };
  return { page, exposed };
}

describe("attachBridge", () => {
  it("installs scripts and adapter callbacks", async () => {
    const { page, exposed } = createMockPage();
    const adapter = {
      name: "x",
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const session = await attachBridge(page as never, { adapter });
    expect(session.mode).toBe("shim");
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(page.addInitScript).toHaveBeenCalled();
    expect(exposed.size).toBe(1);

    await detachBridge(page as never);
    expect(adapter.stop).toHaveBeenCalledOnce();
  });
});
