/**
 * This module implements a Unix-socket local MCP server with JSON-RPC tools and SSE event replay.
 * It depends on event-buffer and MCP type contracts to provide lock-safe single-consumer streaming semantics.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { constants } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "@webmcp-bridge/core";
import { EventBuffer } from "./event-buffer.js";
import type {
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpJsonRpcSuccess,
  McpToolCallParams,
  McpToolDefinition,
} from "./mcp-types.js";

export type LocalMcpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: {
    readOnlyHint?: boolean;
  };
  execute: (input: Record<string, unknown>) => Promise<JsonValue>;
};

export type LocalMcpServerOptions = {
  socketPath: string;
  serviceVersion: string;
  tools?: LocalMcpTool[];
  eventBufferCapacity?: number;
  pingIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export type LocalMcpServer = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  listTools: () => ReadonlyArray<McpToolDefinition>;
  callTool: (name: string, input: Record<string, unknown>) => Promise<JsonValue>;
  registerTool: (tool: LocalMcpTool) => void;
  unregisterTool: (name: string) => void;
  publishEvent: (event: JsonValue) => void;
};

export class LocalMcpServerImpl implements LocalMcpServer {
  private readonly options: LocalMcpServerOptions;
  private readonly lockFilePath: string;
  private readonly tools = new Map<string, LocalMcpTool>();
  private readonly eventBuffer: EventBuffer;
  private server: Server | undefined;
  private activeSseClient = false;
  private activeSseResponse: ServerResponse | undefined;

  constructor(options: LocalMcpServerOptions) {
    this.options = options;
    this.lockFilePath = `${options.socketPath}.lock`;
    this.eventBuffer = new EventBuffer(options.eventBufferCapacity ?? 5000);
    for (const tool of options.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    try {
      await this.acquireLock();
      await rm(this.options.socketPath, { force: true });

      this.server = createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (error) {
          this.options.onError?.(error);
          this.writeJson(res, 500, {
            error: {
              code: "INTERNAL",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            },
          });
        }
      });

      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.options.socketPath, () => {
          resolve();
        });
      });
      await chmod(this.options.socketPath, 0o600);
    } catch (error) {
      await rm(this.options.socketPath, { force: true });
      await rm(this.lockFilePath, { force: true });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = undefined;
    }
    this.activeSseClient = false;
    this.activeSseResponse = undefined;
    await rm(this.options.socketPath, { force: true });
    await rm(this.lockFilePath, { force: true });
  }

  listTools(): ReadonlyArray<McpToolDefinition> {
    return Array.from(this.tools.values()).map((tool) => {
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
    });
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<JsonValue> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`tool not found: ${name}`);
    }
    return await tool.execute(input);
  }

  registerTool(tool: LocalMcpTool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  publishEvent(event: JsonValue): void {
    const buffered = this.eventBuffer.append(event);
    if (this.activeSseResponse && !this.activeSseResponse.writableEnded) {
      this.activeSseResponse.write(`id: ${buffered.seq}\n`);
      this.activeSseResponse.write("event: message\n");
      this.activeSseResponse.write(
        `data: ${JSON.stringify({ seq: buffered.seq, event: buffered.event })}\n\n`,
      );
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      const fd = await open(this.lockFilePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await fd.close();
    } catch {
      throw new Error(`Local MCP lock already held: ${this.lockFilePath}`);
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    if (method === "POST" && url.pathname === "/mcp") {
      const body = await this.readJsonBody<McpJsonRpcRequest>(req);
      const response = await this.handleMcpJsonRpc(body);
      this.writeJson(res, 200, response);
      return;
    }

    if (method === "GET" && url.pathname === "/mcp/events") {
      await this.handleSseEvents(req, res);
      return;
    }

    this.writeJson(res, 404, {
      error: {
        code: "BAD_REQUEST",
        message: "Not found",
        retryable: false,
      },
    });
  }

  private async handleMcpJsonRpc(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0") {
      return this.jsonRpcError(id, -32600, "Invalid Request");
    }

    try {
      if (request.method === "tools/list") {
        const result: McpJsonRpcSuccess = {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.listTools(),
          },
        };
        return result;
      }

      if (request.method === "tools/call") {
        const params = request.params as McpToolCallParams | undefined;
        if (!params || typeof params.name !== "string") {
          return this.jsonRpcError(id, -32602, "Invalid params");
        }
        const args =
          params.arguments && typeof params.arguments === "object"
            ? params.arguments
            : {};
        const toolResult = await this.callTool(params.name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "json",
                json: toolResult,
              },
            ],
          },
        };
      }

      return this.jsonRpcError(id, -32601, "Method not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      return this.jsonRpcError(id, -32000, message, {
        code: message.includes("tool not found") ? "TOOL_NOT_FOUND" : "INTERNAL",
        retryable: false,
      });
    }
  }

  private async handleSseEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.activeSseClient) {
      this.writeJson(res, 409, {
        error: {
          code: "BAD_REQUEST",
          message: "SSE consumer already attached",
          retryable: true,
        },
      });
      return;
    }

    this.activeSseClient = true;
    this.activeSseResponse = res;

    const lastEventId = req.headers["last-event-id"];
    const parsedLastSeq = Number.parseInt(Array.isArray(lastEventId) ? lastEventId[0] ?? "0" : (lastEventId ?? "0"), 10);
    const replay = this.eventBuffer.replayAfter(Number.isNaN(parsedLastSeq) ? 0 : parsedLastSeq);

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    if (replay.overflow) {
      res.write("event: error\n");
      res.write(
        `data: ${JSON.stringify({ code: "REPLAY_OVERFLOW", message: "Replay window exceeded", retryable: false, needResync: true })}\n\n`,
      );
      res.end();
      this.activeSseClient = false;
      this.activeSseResponse = undefined;
      return;
    }

    for (const item of replay.events) {
      res.write(`id: ${item.seq}\n`);
      res.write("event: message\n");
      res.write(`data: ${JSON.stringify({ seq: item.seq, event: item.event })}\n\n`);
    }

    const pingIntervalMs = Math.max(5000, this.options.pingIntervalMs ?? 15000);
    const timer = setInterval(() => {
      res.write("event: ping\n");
      res.write(`data: ${JSON.stringify({ nowMs: Date.now() })}\n\n`);
    }, pingIntervalMs);

    req.on("close", () => {
      clearInterval(timer);
      this.activeSseClient = false;
      this.activeSseResponse = undefined;
    });
  }

  private jsonRpcError(
    id: string | number | null,
    code: number,
    message: string,
    data?: Record<string, unknown>,
  ): McpJsonRpcResponse {
    const error: {
      code: number;
      message: string;
      data?: Record<string, unknown>;
    } = {
      code,
      message,
    };
    if (data !== undefined) {
      error.data = data;
    }
    return {
      jsonrpc: "2.0",
      id,
      error,
    };
  }

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {} as T;
    }
    return JSON.parse(raw) as T;
  }

  private writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    if (res.writableEnded) {
      return;
    }
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }
}

export function createLocalMcpServer(options: LocalMcpServerOptions): LocalMcpServer {
  return new LocalMcpServerImpl(options);
}
