/**
 * This module implements an MCP stdio JSON-RPC server that proxies tool calls to a page WebMCP gateway.
 * It depends on the modelcontextprotocol/sdk server and stdio transport so MCP framing and lifecycle are handled by the official implementation.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import type { Readable, Writable } from "node:stream";
import type { McpToolDefinition } from "./mcp-types.js";

export type LocalMcpGateway = {
  listTools: () => Promise<ReadonlyArray<WebMcpToolDefinition>>;
  callTool: (name: string, input: Record<string, unknown>) => Promise<JsonValue>;
};

export type LocalMcpStdioServerOptions = {
  gateway: LocalMcpGateway;
  serviceVersion: string;
  input?: Readable;
  output?: Writable;
  onError?: (error: unknown) => void;
};

export type LocalMcpStdioServer = {
  start: () => Promise<void>;
  close: () => Promise<void>;
};

class LocalMcpStdioServerImpl implements LocalMcpStdioServer {
  private readonly server: Server;
  private readonly transport: StdioServerTransport;
  private started = false;
  private closed = false;

  constructor(options: LocalMcpStdioServerOptions) {
    this.transport = new StdioServerTransport(options.input, options.output);
    this.transport.onerror = (error) => {
      options.onError?.(error);
    };

    this.server = new Server(
      {
        name: "webmcp-bridge-local-mcp",
        version: options.serviceVersion,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await options.gateway.listTools();
      return {
        tools: tools.map((tool) => this.toMcpToolDefinition(tool)),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const args = this.normalizeToolArguments(request.params.arguments);
      const toolResult = await options.gateway.callTool(request.params.name, args);
      return this.toCallToolResult(toolResult);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.server.connect(this.transport);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.server.close();
  }

  private toMcpToolDefinition(tool: WebMcpToolDefinition): McpToolDefinition {
    const definition: McpToolDefinition = {
      name: tool.name,
    };
    if (tool.description !== undefined) {
      definition.description = tool.description;
    }
    if (tool.inputSchema !== undefined) {
      definition.inputSchema = tool.inputSchema;
    }
    if (tool.annotations !== undefined) {
      definition.annotations = tool.annotations;
    }
    return definition;
  }

  private normalizeToolArguments(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private toStructuredContent(value: JsonValue): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {
      value,
    };
  }

  private toCallToolResult(value: JsonValue): CallToolResult {
    if (this.isCallToolResultPayload(value)) {
      return value as unknown as CallToolResult;
    }

    const result: CallToolResult = {
      content: [],
      structuredContent: this.toStructuredContent(value),
    };
    if (this.isErrorPayload(value)) {
      result.isError = true;
    }
    return result;
  }

  private isCallToolResultPayload(value: JsonValue): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return "content" in value || "structuredContent" in value || "isError" in value;
  }

  private isErrorPayload(value: JsonValue): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return "error" in value;
  }
}

export function createLocalMcpStdioServer(options: LocalMcpStdioServerOptions): LocalMcpStdioServer {
  return new LocalMcpStdioServerImpl(options);
}
