/**
 * This module tests local MCP server JSON-RPC tools and SSE stream semantics over Unix socket.
 * It depends on the server implementation and Node HTTP client to validate lock-safe replay behavior.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalMcpServer, type LocalMcpServer } from "../src/index.js";

type RequestResult = {
  status: number;
  body: unknown;
};

async function sendMcp(socketPath: string, method: string, params?: unknown): Promise<RequestResult> {
  return await new Promise<RequestResult>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: "POST",
        path: "/mcp",
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as unknown) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method,
        params,
      }),
    );
    req.end();
  });
}

async function readSseFirstBlock(socketPath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: "GET",
        path: "/mcp/events",
        headers: {
          accept: "text/event-stream",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (raw.includes("\n\n")) {
            req.destroy();
            resolve(raw);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("local-mcp server", () => {
  let workspaceDir: string;
  let socketPath: string;
  let server: LocalMcpServer;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "local-mcp-"));
    socketPath = join(workspaceDir, "local-mcp.sock");
    server = createLocalMcpServer({
      socketPath,
      serviceVersion: "0.1.0-test",
      tools: [
        {
          name: "x.health",
          description: "health",
          execute: async () => ({ ok: true }),
        },
      ],
      pingIntervalMs: 200,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("responds with tools/list", async () => {
    const result = await sendMcp(socketPath, "tools/list");
    expect(result.status).toBe(200);
    const payload = result.body as { result?: { tools?: Array<{ name?: string }> } };
    expect(payload.result?.tools?.map((tool) => tool.name)).toContain("x.health");
  });

  it("calls registered tool via tools/call", async () => {
    const result = await sendMcp(socketPath, "tools/call", {
      name: "x.health",
      arguments: {},
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      result: {
        content: [{ type: "json", json: { ok: true } }],
      },
    });
  });

  it("streams published events via sse", async () => {
    server.publishEvent({ kind: "message", id: "m_1" });
    const chunk = await readSseFirstBlock(socketPath);
    expect(chunk).toContain("event: message");
    expect(chunk).toContain('"id":"m_1"');
  });

  it("returns replay overflow error when last-event-id is out of window", async () => {
    await server.stop();
    server = createLocalMcpServer({
      socketPath,
      serviceVersion: "0.1.0-test",
      eventBufferCapacity: 1,
      tools: [{ name: "x.health", execute: async () => ({ ok: true }) }],
    });
    await server.start();

    server.publishEvent({ i: 1 });
    server.publishEvent({ i: 2 });
    server.publishEvent({ i: 3 });

    const raw = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: "GET",
          path: "/mcp/events",
          headers: {
            accept: "text/event-stream",
            "last-event-id": "1",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          });
          res.on("end", () => {
            resolve(body);
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(raw).toContain("event: error");
    expect(raw).toContain("REPLAY_OVERFLOW");
  });
});
