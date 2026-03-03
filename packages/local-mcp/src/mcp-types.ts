/**
 * This module defines MCP JSON-RPC and SSE payload contracts used by the local MCP host/client.
 * It is depended on by server and client modules to keep transport parsing and framing behavior aligned.
 */

import type { JsonValue } from "@webmcp-bridge/core";

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
  id?: string | number | null;
  method: "tools/list" | "tools/call";
  params?: Record<string, unknown>;
};

export type McpToolCallParams = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type McpJsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: Record<string, unknown>;
};

export type McpJsonRpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

export type McpJsonRpcResponse = McpJsonRpcSuccess | McpJsonRpcError;

export type McpToolListResult = {
  tools: McpToolDefinition[];
};

export type McpToolCallResult = {
  content: Array<{
    type: "json";
    json: JsonValue;
  }>;
};

export type McpSseMessagePayload = {
  seq: number;
  event: JsonValue;
};

export type McpSseErrorPayload = {
  code: "REPLAY_OVERFLOW" | "INTERNAL";
  message: string;
  retryable: boolean;
  needResync?: boolean;
};

export type McpSseEvent = {
  id?: string;
  event: string;
  data: string;
};
