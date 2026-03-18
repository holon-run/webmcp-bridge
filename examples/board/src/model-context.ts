/**
 * This module provides a self-hosted navigator.modelContext implementation for the native example app.
 * It depends on local WebMCP types and is used by the tool registration layer so the example works in standard browsers.
 */

import type {
  JsonValue,
  WebMcpModelContext,
  WebMcpResourceDefinition,
  WebMcpToolDefinition,
} from "./types.js";

const CONTEXT_KEY = "__webmcpBoardModelContext";
const RESOURCE_UPDATED_CALLBACK_KEY = "__WEBMCP_BRIDGE_NOTIFY_RESOURCE_UPDATED__";

type MutableNavigator = Navigator & {
  modelContext?: WebMcpModelContext;
};

function toResourceDescriptor(resource: WebMcpResourceDefinition): Omit<WebMcpResourceDefinition, "read"> {
  return {
    uri: resource.uri,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
  };
}

type GlobalWithContext = typeof globalThis & {
  [CONTEXT_KEY]?: WebMcpModelContext;
  [RESOURCE_UPDATED_CALLBACK_KEY]?: (uri: string) => Promise<void>;
};

export function ensureModelContext(target: typeof globalThis = globalThis): WebMcpModelContext {
  const globalWithContext = target as GlobalWithContext;
  if (globalWithContext[CONTEXT_KEY]) {
    return globalWithContext[CONTEXT_KEY];
  }

  const tools = new Map<string, WebMcpToolDefinition>();
  const resources = new Map<string, WebMcpResourceDefinition>();
  const providedContext: JsonValue[] = [];

  const modelContext: WebMcpModelContext = {
    provideContext: async (context) => {
      providedContext.push(context);
    },
    clearContext: async () => {
      providedContext.splice(0, providedContext.length);
      tools.clear();
      resources.clear();
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
    registerResource: async (resource) => {
      if (!resource.uri.trim()) {
        throw new Error("resource.uri is required");
      }
      resources.set(resource.uri, resource);
    },
    unregisterResource: async (uri) => {
      resources.delete(uri);
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
    listResources: async () => {
      return [...resources.values()].map(toResourceDescriptor);
    },
    readResource: async (uri) => {
      const resource = resources.get(uri);
      if (!resource) {
        throw new Error(`resource not found: ${uri}`);
      }
      return await resource.read();
    },
    notifyResourceUpdated: async (uri) => {
      await globalWithContext[RESOURCE_UPDATED_CALLBACK_KEY]?.(uri);
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
