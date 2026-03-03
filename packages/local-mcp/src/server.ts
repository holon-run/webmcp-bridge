/**
 * This module provides a local MCP host skeleton with in-memory tool registry.
 * It depends on core tool definition types so runtime adapters can be mounted consistently.
 */

import type { BridgeToolDefinition, JsonValue } from "@webmcp-bridge/core";

export type LocalMcpServer = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  listTools: () => ReadonlyArray<BridgeToolDefinition>;
  callTool: (name: string, input: JsonValue) => Promise<JsonValue>;
};

export type CreateLocalMcpServerOptions = {
  tools?: BridgeToolDefinition[];
};

export function createLocalMcpServer(options?: CreateLocalMcpServerOptions): LocalMcpServer {
  const tools = new Map<string, BridgeToolDefinition>();
  for (const tool of options?.tools ?? []) {
    tools.set(tool.name, tool);
  }

  return {
    start: async () => {
      // skeleton: transport wiring is intentionally deferred
    },
    stop: async () => {
      // skeleton: transport wiring is intentionally deferred
    },
    listTools: () => Array.from(tools.values()),
    callTool: async (name, input) => {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`tool not found: ${name}`);
      }
      return await tool.execute(input);
    },
  };
}
