/**
 * This module provides a native-first WebMCP page gateway with polyfill and adapter-shim fallback wiring.
 * It depends on Playwright page APIs and shared bridge types so local-mcp can call browser WebMCP uniformly.
 */

import { randomUUID } from "node:crypto";
import type { JsonValue } from "@webmcp-bridge/core";
import type { Page } from "playwright";
import type {
  CreateWebMcpPageGatewayOptions,
  SiteAdapter,
  WebMcpPageGateway,
  WebMcpToolDefinition,
} from "./types.js";

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
    globalAny.__webmcpBridge = {
      list: async () => {
        if (typeof navAny.modelContext.listTools === "function") {
          const nativeTools = await navAny.modelContext.listTools();
          return Array.isArray(nativeTools) ? nativeTools : [];
        }
        return [];
      },
      invoke: async (name, input) => {
        if (typeof navAny.modelContext.callTool !== "function") {
          throw new Error("native modelContext callTool is not available");
        }
        return await navAny.modelContext.callTool(String(name || ""), input || {});
      },
    };
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
    listTools: async () =>
      Array.from(tools.values()).map((tool) => {
        const output = {
          name: tool.name,
          inputSchema: tool.inputSchema || { type: "object" },
          annotations: tool.annotations || {},
        };
        if (typeof tool.description === "string" && tool.description.trim()) {
          return { ...output, description: tool.description };
        }
        return output;
      }),
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
    list: async () => await modelContext.listTools(),
    invoke: async (name, input) => {
      return await modelContext.callTool(String(name || ""), input || {});
    },
  };

  globalAny.__WEBMCP_BRIDGE_MODE__ = "polyfill";
})();
`;

type GatewaySession = {
  gateway: WebMcpPageGateway;
  cleanup: () => Promise<void>;
};

const SESSIONS = new WeakMap<Page, GatewaySession>();

export async function createWebMcpPageGateway(
  page: Page,
  options?: CreateWebMcpPageGatewayOptions,
): Promise<WebMcpPageGateway> {
  const existing = SESSIONS.get(page);
  if (existing) {
    return existing.gateway;
  }

  const fallbackAdapter: SiteAdapter | undefined = options?.fallbackAdapter;
  const preferNative = options?.preferNative ?? true;
  const reinjectOnNavigate = options?.reinjectOnNavigate ?? true;
  let fallbackStarted = false;
  let fallbackStartPromise: Promise<void> | undefined;
  const ensureFallbackStarted = async (): Promise<void> => {
    if (!fallbackAdapter || fallbackStarted) {
      return;
    }
    if (!fallbackStartPromise) {
      fallbackStartPromise = (async () => {
        await fallbackAdapter.start?.({ page });
        fallbackStarted = true;
      })();
    }
    await fallbackStartPromise;
  };

  const exposedName = `__WEBMCP_BRIDGE_CALL__${randomUUID().replaceAll("-", "")}`;
  await page.exposeFunction(exposedName, async (name: string, input: JsonValue) => {
    if (!fallbackAdapter) {
      return {
        error: {
          code: "NOT_SUPPORTED",
          message: "fallback adapter is not configured",
        },
      } satisfies JsonValue;
    }
    await ensureFallbackStarted();
    return await fallbackAdapter.callTool({ name, input }, { page });
  });

  const bindScript = `window.__WEBMCP_BRIDGE_CALL__ = window.${exposedName};`;

  await page.addInitScript(INJECT_SCRIPT);
  await page.addInitScript(bindScript);
  await page.evaluate(INJECT_SCRIPT);
  await page.evaluate(bindScript);

  const detectedMode = await page.evaluate(() => {
    const globalAny = window as unknown as { __WEBMCP_BRIDGE_MODE__?: "native" | "polyfill" };
    return globalAny.__WEBMCP_BRIDGE_MODE__ ?? "polyfill";
  });

  const mode: "native" | "polyfill" | "adapter-shim" =
    preferNative && detectedMode === "native"
      ? "native"
      : fallbackAdapter
        ? "adapter-shim"
        : "polyfill";
  if (mode === "adapter-shim") {
    await ensureFallbackStarted();
  }

  const rebindOnNavigate = (): void => {
    void page.evaluate(bindScript).catch(() => {
      // Ignore transient navigation races; the init script will rebind on next document.
    });
  };

  if (reinjectOnNavigate) {
    page.on("framenavigated", rebindOnNavigate);
  }

  const gateway: WebMcpPageGateway = {
    id: randomUUID(),
    mode,
    page,
    listTools: async (): Promise<WebMcpToolDefinition[]> => {
      if (mode === "adapter-shim" && fallbackAdapter) {
        await ensureFallbackStarted();
        const adapterTools = await fallbackAdapter.listTools({ page });
        return adapterTools.map((tool) => ({
          ...tool,
          inputSchema: tool.inputSchema ?? { type: "object" },
        }));
      }
      return await page.evaluate(async () => {
        const globalAny = window as unknown as {
          __webmcpBridge?: { list?: () => Promise<unknown> | unknown };
        };
        const list = globalAny.__webmcpBridge?.list;
        if (typeof list !== "function") {
          return [];
        }
        const tools = await list();
        return Array.isArray(tools) ? tools : [];
      });
    },
    callTool: async (name: string, input: JsonValue): Promise<JsonValue> => {
      const payload: { callName: string; callInput: unknown } = {
        callName: name,
        callInput: input,
      };
      const result: unknown = await page.evaluate(
        async ({ callName, callInput }) => {
          const globalAny = window as unknown as {
            __webmcpBridge?: {
              invoke?: (name: string, input: unknown) => Promise<unknown> | unknown;
            };
          };
          const invoke = globalAny.__webmcpBridge?.invoke;
          if (typeof invoke !== "function") {
            throw new Error("WebMCP bridge invoke handler missing");
          }
          return await invoke(String(callName || ""), callInput ?? {});
        },
        payload,
      );
      return result as JsonValue;
    },
    close: async (): Promise<void> => {
      const session = SESSIONS.get(page);
      if (!session) {
        return;
      }
      await session.cleanup();
      SESSIONS.delete(page);
    },
  };

  const cleanup = async (): Promise<void> => {
    if (reinjectOnNavigate) {
      const pageEvents = page as unknown as {
        removeListener?: (event: string, listener: () => void) => unknown;
        removeAllListeners?: (event: string) => unknown;
      };
      if (typeof pageEvents.removeListener === "function") {
        pageEvents.removeListener("framenavigated", rebindOnNavigate);
      } else if (typeof pageEvents.removeAllListeners === "function") {
        pageEvents.removeAllListeners("framenavigated");
      }
    }
    if (fallbackStarted) {
      await fallbackAdapter?.stop?.({ page });
    }
  };

  SESSIONS.set(page, { gateway, cleanup });
  return gateway;
}

export async function closeWebMcpPageGateway(page: Page): Promise<void> {
  const session = SESSIONS.get(page);
  if (!session) {
    return;
  }
  await session.cleanup();
  SESSIONS.delete(page);
}
