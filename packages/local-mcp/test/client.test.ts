/**
 * This module tests local MCP client JSON-RPC and SSE parsing behavior.
 * It depends on the local MCP server and client modules to validate end-to-end Unix-socket interoperability.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalMcpClient,
  LocalMcpHttpError,
  createLocalMcpServer,
  type LocalMcpServer,
} from "../src/index.js";

describe("LocalMcpClient", () => {
  let workspaceDir: string;
  let socketPath: string;
  let server: LocalMcpServer;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "local-mcp-client-"));
    socketPath = join(workspaceDir, "local-mcp.sock");
    server = createLocalMcpServer({
      socketPath,
      serviceVersion: "0.1.0-test",
      tools: [
        {
          name: "x.health",
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

  it("lists tools and calls tool successfully", async () => {
    const client = new LocalMcpClient({ socketPath });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("x.health");

    const result = await client.callTool<{ ok: boolean }>("x.health", {});
    expect(result).toEqual({ ok: true });
  });

  it("maps tool not found to LocalMcpHttpError", async () => {
    const client = new LocalMcpClient({ socketPath });
    await expect(client.callTool("x.unknown", {})).rejects.toBeInstanceOf(LocalMcpHttpError);
  });

  it("consumes message event from SSE", async () => {
    const client = new LocalMcpClient({ socketPath });
    const seen: string[] = [];

    const abort = new AbortController();
    const consume = client.consumeEventStream({
      heartbeatTimeoutMs: 2000,
      signal: abort.signal,
      onEvent: (event) => {
        if (event.event !== "message") {
          return;
        }
        seen.push(event.data);
        abort.abort();
      },
    });

    server.publishEvent({ id: "m_1" });

    await expect(consume).rejects.toBeInstanceOf(Error);
    expect(seen.join("\n")).toContain('"id":"m_1"');
  });
});
