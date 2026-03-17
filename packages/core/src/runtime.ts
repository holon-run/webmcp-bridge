/**
 * This module builds the in-memory modelContext shim runtime.
 * It depends on shared type contracts and is used by install logic to expose tool registration and invocation behavior.
 */

import type {
  BridgeResourceDefinition,
  BridgeResourceDescriptor,
  BridgeToolDefinition,
  BridgeTransport,
  JsonValue,
  ModelContextLike,
} from "./types.js";

export type BridgeRuntime = {
  modelContext: ModelContextLike;
  listTools: () => ReadonlyArray<BridgeToolDefinition>;
  invokeTool: (name: string, input: JsonValue) => Promise<JsonValue>;
  listResources: () => ReadonlyArray<BridgeResourceDescriptor>;
  readResource: (uri: string) => Promise<JsonValue>;
  onResourceUpdated: (listener: (uri: string) => void) => () => void;
  clear: () => void;
};

export function createBridgeRuntime(transport?: BridgeTransport): BridgeRuntime {
  const contexts: JsonValue[] = [];
  const tools = new Map<string, BridgeToolDefinition>();
  const resources = new Map<string, BridgeResourceDefinition>();
  const resourceListeners = new Set<(uri: string) => void>();

  const invokeTool = async (name: string, input: JsonValue): Promise<JsonValue> => {
    const localTool = tools.get(name);
    if (localTool) {
      return await localTool.execute(input);
    }
    if (transport) {
      return await transport.call(name, input);
    }
    throw new Error(`tool not found: ${name}`);
  };

  const modelContext: ModelContextLike = {
    provideContext: async (context) => {
      contexts.push(context);
    },
    clearContext: async () => {
      contexts.splice(0, contexts.length);
      tools.clear();
      resources.clear();
    },
    registerTool: async (tool) => {
      if (!tool.name.trim()) {
        throw new Error("tool.name is required");
      }
      if (tools.has(tool.name)) {
        throw new Error(`tool already registered: ${tool.name}`);
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
    listResources: async () =>
      Array.from(resources.values()).map(({ read: _read, ...descriptor }) => descriptor),
    readResource: async (uri) => {
      const resource = resources.get(uri);
      if (!resource) {
        throw new Error(`resource not found: ${uri}`);
      }
      return await resource.read();
    },
    notifyResourceUpdated: async (uri) => {
      for (const listener of resourceListeners) {
        listener(uri);
      }
    },
  };

  return {
    modelContext,
    listTools: () => Array.from(tools.values()),
    invokeTool,
    listResources: () => Array.from(resources.values()).map(({ read: _read, ...descriptor }) => descriptor),
    readResource: async (uri) => {
      const resource = resources.get(uri);
      if (!resource) {
        throw new Error(`resource not found: ${uri}`);
      }
      return await resource.read();
    },
    onResourceUpdated: (listener) => {
      resourceListeners.add(listener);
      return () => {
        resourceListeners.delete(listener);
      };
    },
    clear: () => {
      contexts.splice(0, contexts.length);
      tools.clear();
      resources.clear();
      resourceListeners.clear();
    },
  };
}
