/**
 * This module builds the in-memory modelContext shim runtime.
 * It depends on shared type contracts and is used by install logic to expose tool registration and invocation behavior.
 */

import type {
  BridgeToolDefinition,
  BridgeTransport,
  JsonValue,
  ModelContextLike,
} from "./types.js";

export type BridgeRuntime = {
  modelContext: ModelContextLike;
  listTools: () => ReadonlyArray<BridgeToolDefinition>;
  invokeTool: (name: string, input: JsonValue) => Promise<JsonValue>;
  clear: () => void;
};

export function createBridgeRuntime(transport?: BridgeTransport): BridgeRuntime {
  const contexts: JsonValue[] = [];
  const tools = new Map<string, BridgeToolDefinition>();

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
  };

  return {
    modelContext,
    listTools: () => Array.from(tools.values()),
    invokeTool,
    clear: () => {
      contexts.splice(0, contexts.length);
      tools.clear();
    },
  };
}
