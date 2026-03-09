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
  private lastToolsSignature: string | undefined;

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
          tools: {
            listChanged: true,
          },
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await options.gateway.listTools();
      this.lastToolsSignature = this.computeToolsSignature(tools);
      return {
        tools: tools.map((tool) => this.toMcpToolDefinition(tool)),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const previousSignature = await this.ensureToolsSignature(options.gateway);
      const args = this.normalizeToolArguments(request.params.arguments);
      const toolResult = await options.gateway.callTool(request.params.name, args);
      await this.notifyIfToolsChanged(options.gateway, previousSignature);
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private isContentArray(value: unknown): value is Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return false;
    }
    return value.every((item) => this.isRecord(item) && typeof item.type === "string");
  }

  private isCallToolResultPayload(value: JsonValue): boolean {
    if (!this.isRecord(value)) {
      return false;
    }
    let hasKnownField = false;
    if ("content" in value) {
      hasKnownField = true;
      if (!this.isContentArray(value.content)) {
        return false;
      }
    }
    if ("structuredContent" in value) {
      hasKnownField = true;
      if (!this.isRecord(value.structuredContent)) {
        return false;
      }
    }
    if ("isError" in value) {
      hasKnownField = true;
      if (typeof value.isError !== "boolean") {
        return false;
      }
    }
    return hasKnownField;
  }

  private isErrorPayload(value: JsonValue): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return "error" in value;
  }

  private async ensureToolsSignature(gateway: LocalMcpGateway): Promise<string> {
    if (this.lastToolsSignature !== undefined) {
      return this.lastToolsSignature;
    }
    const tools = await gateway.listTools();
    const signature = this.computeToolsSignature(tools);
    this.lastToolsSignature = signature;
    return signature;
  }

  private async notifyIfToolsChanged(gateway: LocalMcpGateway, previousSignature: string): Promise<void> {
    const tools = await gateway.listTools();
    const nextSignature = this.computeToolsSignature(tools);
    this.lastToolsSignature = nextSignature;
    if (nextSignature === previousSignature) {
      return;
    }
    await this.server.sendToolListChanged().catch(() => {
      // Ignore when client does not advertise listChanged support or session is not notification-ready.
    });
  }

  private computeToolsSignature(tools: ReadonlyArray<WebMcpToolDefinition>): string {
    const normalized = tools
      .map((tool) => ({
        annotations: this.normalizeForSignature(tool.annotations ?? {}),
        description: tool.description ?? "",
        inputSchema: this.normalizeForSignature(tool.inputSchema ?? { type: "object" }),
        name: tool.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify(normalized);
  }

  private normalizeForSignature(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeForSignature(item));
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      const output: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        output[key] = this.normalizeForSignature(item);
      }
      return output;
    }
    return value;
  }
}

export function createLocalMcpStdioServer(options: LocalMcpStdioServerOptions): LocalMcpStdioServer {
  return new LocalMcpStdioServerImpl(options);
}
