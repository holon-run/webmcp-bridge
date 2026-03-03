/**
 * This module implements a Unix-socket MCP JSON-RPC and SSE client for local MCP servers.
 * It is depended on by connectors and examples so they can call tools and consume event streams uniformly.
 */

import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { JsonValue } from "@webmcp-bridge/core";
import type {
  McpJsonRpcError,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpSseErrorPayload,
  McpSseEvent,
  McpSseMessagePayload,
  McpToolDefinition,
} from "./mcp-types.js";

export class LocalMcpHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(options: {
    status: number;
    message: string;
    code?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "LocalMcpHttpError";
    this.status = options.status;
    this.code = options.code ?? "INTERNAL";
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export type LocalMcpClientOptions = {
  socketPath: string;
};

export class LocalMcpClient {
  private readonly socketPath: string;

  constructor(options: LocalMcpClientOptions) {
    this.socketPath = options.socketPath;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const response = await this.requestJsonRpc({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/list",
    });
    if ("error" in response) {
      throw this.toError(response);
    }
    const tools = response.result?.tools;
    if (!Array.isArray(tools)) {
      throw new LocalMcpHttpError({
        status: 500,
        message: "invalid tools/list response",
      });
    }
    return tools as McpToolDefinition[];
  }

  async callTool<T extends JsonValue>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.requestJsonRpc({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    });
    if ("error" in response) {
      throw this.toError(response);
    }
    const content = response.result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new LocalMcpHttpError({
        status: 500,
        message: "invalid tools/call response",
      });
    }
    const first = content[0] as { json?: JsonValue };
    return first.json as T;
  }

  async requestJsonRpc(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    return await new Promise<McpJsonRpcResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method: "POST",
          path: "/mcp",
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) {
              reject(
                new LocalMcpHttpError({
                  status: res.statusCode ?? 500,
                  message: "empty mcp response",
                }),
              );
              return;
            }
            try {
              resolve(JSON.parse(raw) as McpJsonRpcResponse);
            } catch {
              reject(
                new LocalMcpHttpError({
                  status: res.statusCode ?? 500,
                  message: "invalid mcp json response",
                }),
              );
            }
          });
        },
      );
      req.setTimeout(30000, () => {
        req.destroy(new Error("mcp request timeout"));
      });
      req.on("error", reject);
      req.write(JSON.stringify(request));
      req.end();
    });
  }

  async consumeEventStream(options: {
    lastEventId?: string;
    heartbeatTimeoutMs: number;
    onEvent: (event: McpSseEvent) => Promise<void> | void;
    signal?: AbortSignal;
  }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method: "GET",
          path: "/mcp/events",
          headers: options.lastEventId
            ? {
                accept: "text/event-stream",
                "last-event-id": options.lastEventId,
              }
            : {
                accept: "text/event-stream",
              },
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 400) {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            res.on("end", () => {
              reject(
                new LocalMcpHttpError({
                  status: res.statusCode ?? 500,
                  message: Buffer.concat(chunks).toString("utf8") || "stream open failed",
                }),
              );
            });
            return;
          }

          let pending = "";
          let watchdog: NodeJS.Timeout | undefined;
          const resetWatchdog = () => {
            if (watchdog) {
              clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
              req.destroy(new Error("stream heartbeat timeout"));
            }, options.heartbeatTimeoutMs);
          };
          resetWatchdog();

          const parseAndEmit = async (block: string) => {
            const lines = block
              .split("\n")
              .map((line) => line.replace(/\r$/, ""))
              .filter((line) => line.length > 0);
            if (lines.length === 0) {
              return;
            }
            let id: string | undefined;
            let event = "message";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("id:")) {
                id = line.slice(3).trim();
                continue;
              }
              if (line.startsWith("event:")) {
                event = line.slice(6).trim();
                continue;
              }
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
              }
            }
            const sseEvent: McpSseEvent = {
              event,
              data: dataLines.join("\n"),
            };
            if (id !== undefined) {
              sseEvent.id = id;
            }
            await options.onEvent(sseEvent);
          };

          res.on("data", (chunk) => {
            resetWatchdog();
            pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            const blocks = pending.split("\n\n");
            pending = blocks.pop() ?? "";
            void (async () => {
              for (const block of blocks) {
                await parseAndEmit(block);
              }
            })().catch((error: unknown) => {
              req.destroy(error instanceof Error ? error : new Error(String(error)));
            });
          });

          res.on("end", () => {
            if (watchdog) {
              clearTimeout(watchdog);
            }
            resolve();
          });
        },
      );

      const abortHandler = () => {
        req.destroy(new Error("stream aborted"));
      };
      options.signal?.addEventListener("abort", abortHandler);

      req.on("error", reject);
      req.on("close", () => {
        options.signal?.removeEventListener("abort", abortHandler);
      });
      req.end();
    });
  }

  parseSseMessagePayload(raw: string): McpSseMessagePayload {
    return JSON.parse(raw) as McpSseMessagePayload;
  }

  parseSseErrorPayload(raw: string): McpSseErrorPayload {
    return JSON.parse(raw) as McpSseErrorPayload;
  }

  private toError(response: McpJsonRpcError): LocalMcpHttpError {
    const data = response.error.data ?? {};
    const errorOptions: {
      status: number;
      message: string;
      code?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {
      status: 500,
      message: response.error.message,
      code: typeof data.code === "string" ? data.code : "INTERNAL",
      retryable: Boolean(data.retryable),
    };
    if (typeof data.details === "object" && data.details) {
      errorOptions.details = data.details as Record<string, unknown>;
    }
    return new LocalMcpHttpError(errorOptions);
  }
}
