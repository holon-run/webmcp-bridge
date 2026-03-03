/**
 * This module defines the shared WebMCP bridge contracts.
 * It is depended on by runtime/install modules and downstream integrations like playwright and adapters.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type BridgeToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  execute: (input: JsonValue) => Promise<JsonValue>;
};

export type BridgeTransport = {
  call: (name: string, input: JsonValue) => Promise<JsonValue>;
};

export type ModelContextLike = {
  provideContext: (context: JsonValue) => Promise<void>;
  clearContext: () => Promise<void>;
  registerTool: (tool: BridgeToolDefinition) => Promise<void>;
  unregisterTool: (name: string) => Promise<void>;
};

export type BridgeInstallTarget = {
  navigator: {
    modelContext?: ModelContextLike;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type BridgeHandle = {
  mode: "native" | "shim";
  listTools: () => ReadonlyArray<BridgeToolDefinition>;
  invokeTool: (name: string, input: JsonValue) => Promise<JsonValue>;
  uninstall: () => void;
};
