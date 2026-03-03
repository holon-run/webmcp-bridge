/**
 * This module attaches the WebMCP bridge into a Playwright page and wires tool calls to a Node-side adapter.
 * It depends on core bridge types and Playwright page hooks for init script injection and exposed callbacks.
 */

import { randomUUID } from "node:crypto";
import type { JsonValue } from "@webmcp-bridge/core";
import type { Page } from "playwright";
import type {
  PlaywrightBridgeOptions,
  PlaywrightBridgeSession,
  SiteAdapter,
} from "./types.js";

const SESSIONS = new WeakMap<Page, { session: PlaywrightBridgeSession; cleanup: () => Promise<void> }>();

const INJECT_SCRIPT = String.raw`
(() => {
  const navAny = navigator;
  const globalAny = window;
  const hasNative =
    navAny &&
    navAny.modelContext &&
    typeof navAny.modelContext.registerTool === "function" &&
    typeof navAny.modelContext.unregisterTool === "function";
  if (hasNative) {
    globalAny.__WEBMCP_BRIDGE_MODE__ = "native";
    return;
  }

  const tools = new Map();
  const contexts = [];

  const modelContext = {
    provideContext: async (context) => {
      contexts.push(context || {});
    },
    clearContext: async () => {
      contexts.splice(0, contexts.length);
      tools.clear();
    },
    registerTool: async (tool) => {
      const name = tool && typeof tool.name === "string" ? tool.name : "";
      if (!name) {
        throw new Error("tool.name is required");
      }
      if (tools.has(name)) {
        throw new Error("tool already registered");
      }
      tools.set(name, tool);
    },
    unregisterTool: async (name) => {
      tools.delete(String(name || ""));
    },
    callTool: async (name, input) => {
      const local = tools.get(String(name || ""));
      if (local && typeof local.execute === "function") {
        return await local.execute(input || {});
      }
      if (typeof globalAny.__WEBMCP_BRIDGE_CALL__ !== "function") {
        throw new Error("bridge call handler missing");
      }
      return await globalAny.__WEBMCP_BRIDGE_CALL__(String(name || ""), input || {});
    },
  };

  try {
    Object.defineProperty(navAny, "modelContext", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: modelContext,
    });
  } catch {
    navAny.modelContext = modelContext;
  }
  globalAny.__webmcpBridge = {
    list: () =>
      Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object" },
        annotations: tool.annotations || {},
      })),
    invoke: async (name, input) => {
      return await modelContext.callTool(String(name || ""), input || {});
    },
  };
  globalAny.__WEBMCP_BRIDGE_MODE__ = "shim";
})();
`;

export async function attachBridge(
  page: Page,
  options: PlaywrightBridgeOptions,
): Promise<PlaywrightBridgeSession> {
  const existing = SESSIONS.get(page);
  if (existing) {
    return existing.session;
  }

  const preferNative = options.preferNative ?? true;
  const reinjectOnNavigate = options.reinjectOnNavigate ?? true;
  const adapter: SiteAdapter = options.adapter;

  await adapter.start?.({ page });

  const exposedName = `__WEBMCP_BRIDGE_CALL__${randomUUID().replaceAll("-", "")}`;
  await page.exposeFunction(exposedName, async (name: string, input: JsonValue) => {
    return await adapter.callTool({ name, input }, { page });
  });

  const bindScript = `window.__WEBMCP_BRIDGE_CALL__ = window.${exposedName};`;

  await page.addInitScript(INJECT_SCRIPT);
  await page.addInitScript(bindScript);
  await page.evaluate(INJECT_SCRIPT);
  await page.evaluate(bindScript);

  const mode = await page.evaluate(() => {
    const globalAny = window as unknown as { __WEBMCP_BRIDGE_MODE__?: "native" | "shim" };
    return globalAny.__WEBMCP_BRIDGE_MODE__ ?? "shim";
  });

  const onNavigate = async (): Promise<void> => {
    await page.evaluate(bindScript);
  };

  if (reinjectOnNavigate) {
    page.on("framenavigated", () => {
      void onNavigate();
    });
  }

  const session: PlaywrightBridgeSession = {
    id: randomUUID(),
    mode: preferNative && mode === "native" ? "native" : "shim",
    page,
    adapter,
  };

  const cleanup = async () => {
    if (reinjectOnNavigate) {
      page.removeAllListeners("framenavigated");
    }
    await adapter.stop?.({ page });
  };

  SESSIONS.set(page, { session, cleanup });
  return session;
}

export async function detachBridge(page: Page): Promise<void> {
  const existing = SESSIONS.get(page);
  if (!existing) {
    return;
  }
  await existing.cleanup();
  SESSIONS.delete(page);
}
