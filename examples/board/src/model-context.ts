/**
 * This module provides a self-hosted navigator.modelContext implementation for the native example app.
 * It depends on local WebMCP types and is used by the tool registration layer so the example works in standard browsers.
 */

import type { JsonValue, WebMcpModelContext, WebMcpToolDefinition } from "./types.js";

const CONTEXT_KEY = "__webmcpBoardModelContext";

type MutableNavigator = Navigator & {
  modelContext?: WebMcpModelContext;
};

type GlobalWithContext = typeof globalThis & {
  [CONTEXT_KEY]?: WebMcpModelContext;
};

export function ensureModelContext(target: typeof globalThis = globalThis): WebMcpModelContext {
  const globalWithContext = target as GlobalWithContext;
  if (globalWithContext[CONTEXT_KEY]) {
    return globalWithContext[CONTEXT_KEY];
  }

  const tools = new Map<string, WebMcpToolDefinition>();
  const providedContext: JsonValue[] = [];

  const modelContext: WebMcpModelContext = {
    provideContext: async (context) => {
      providedContext.push(context);
    },
    clearContext: async () => {
      providedContext.splice(0, providedContext.length);
      tools.clear();
    },
    registerTool: async (tool) => {
      if (!tool.name.trim()) {
        throw new Error("tool.name is required");
      }
      tools.set(tool.name, tool);
    },
    unregisterTool: async (name) => {
      tools.delete(name);
    },
    listTools: async () => {
      return [...tools.values()];
    },
    callTool: async (name, input) => {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`tool not found: ${name}`);
      }
      return await tool.execute(input);
    },
  };

  const navigatorWithContext = target.navigator as MutableNavigator;
  if (!navigatorWithContext.modelContext) {
    Object.defineProperty(target.navigator, "modelContext", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: modelContext,
    });
  }

  globalWithContext[CONTEXT_KEY] = navigatorWithContext.modelContext ?? modelContext;
  return globalWithContext[CONTEXT_KEY];
}
