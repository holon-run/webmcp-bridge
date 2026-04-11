/**
 * This module defines MCP JSON-RPC types for stdio transport and WebMCP proxy methods.
 * It is depended on by local server tests and shared exports so JSON-RPC and tool payload typings remain consistent.
 */

import type { JsonValue } from "@webmcp-bridge/core";

export type McpJsonRpcId = string | number | null;

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: {
    readOnlyHint?: boolean;
  };
};

export type McpJsonRpcRequest = {
  jsonrpc: "2.0";
  id?: McpJsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type McpJsonRpcSuccess = {
  jsonrpc: "2.0";
  id: McpJsonRpcId;
  result: Record<string, unknown>;
};

export type McpJsonRpcError = {
  jsonrpc: "2.0";
  id: McpJsonRpcId;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

export type McpJsonRpcResponse = McpJsonRpcSuccess | McpJsonRpcError;

export type McpToolCallParams = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type McpInitializeResult = {
  protocolVersion: string;
  capabilities: {
    tools: {
      listChanged: boolean;
    };
    resources?: {
      subscribe?: boolean;
    };
  };
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
};

export type McpLifecycleContractResult = {
  reap_policy: "safe_idle_reap" | "stateful";
};

export type McpLifecycleSnapshot = {
  auto_reap_allowed: boolean;
  retention_reason?: string | null;
  retry_after_secs?: number;
  updated_at_unix: number;
};

export type McpResourceDefinition = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpToolListResult = {
  tools: McpToolDefinition[];
};

export type McpToolCallResult = {
  content?: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpResourceListResult = {
  resources: McpResourceDefinition[];
};

export type McpReadResourceResult = {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
};
