/**
 * This module verifies the native board example through the local-mcp stdio bridge.
 * It depends on the example's Vite dev server and local-mcp bridge so the end-to-end native WebMCP path stays working.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { createServer, type ViteDevServer } from "vite";
import type { McpJsonRpcResponse } from "../../../packages/local-mcp/src/mcp-types.js";
import { startLocalMcpBridge, type LocalMcpBridgeHandle } from "../../../packages/local-mcp/src/bridge.js";

type JsonRpcFrame = Record<string, unknown>;

const EXAMPLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 90_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor<T>(load: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await load();
    if (accept(lastValue)) {
      return lastValue;
    }
    await delay(150);
  }
  throw new Error(`timeout waiting for condition; last value: ${JSON.stringify(lastValue)}`);
}

function readResult(response: McpJsonRpcResponse): Record<string, unknown> {
  if ("error" in response) {
    throw new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`);
  }
  return response.result;
}

function readStructuredContent(response: McpJsonRpcResponse): Record<string, unknown> {
  const result = readResult(response);
  const structuredContent = result.structuredContent;
  if (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) {
    throw new Error(`missing structuredContent in response: ${JSON.stringify(result)}`);
  }
  return structuredContent as Record<string, unknown>;
}

class McpTestClient {
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private readonly frames: JsonRpcFrame[] = [];
  private outputBuffer = "";
  private nextRequestId = 0;
  private bridgeHandle: LocalMcpBridgeHandle | undefined;

  constructor(private readonly url: string, private readonly userDataDir: string) {
    this.output.on("data", (chunk: Buffer | string) => {
      this.outputBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const lines = this.outputBuffer.split("\n");
      this.outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.frames.push(JSON.parse(trimmed) as JsonRpcFrame);
      }
    });
  }

  async start(): Promise<LocalMcpBridgeHandle> {
    this.bridgeHandle = await startLocalMcpBridge({
      url: this.url,
      headless: true,
      userDataDir: this.userDataDir,
      serviceVersion: "0.1.0-test",
      input: this.input,
      output: this.output,
    });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      clientInfo: {
        name: "board-test",
        version: "0.1.0-test",
      },
    });
    return this.bridgeHandle;
  }

  async close(): Promise<void> {
    await this.bridgeHandle?.close();
    this.input.end();
    this.output.end();
    this.output.removeAllListeners();
  }

  async request(method: string, params: Record<string, unknown>): Promise<McpJsonRpcResponse> {
    const id = `req-${this.nextRequestId}`;
    this.nextRequestId += 1;
    const beforeCount = this.frames.length;
    this.input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      })}\n`,
    );
    const response = await waitFor(
      async () => {
        return this.frames
          .slice(beforeCount)
          .find((frame) => "id" in frame && frame.id === id) as McpJsonRpcResponse | undefined;
      },
      (response) => response !== undefined,
      15_000,
    );
    if (!response) {
      throw new Error(`missing response for ${method}`);
    }
    return response;
  }
}

async function startExampleServer(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    root: EXAMPLE_ROOT,
    configFile: resolve(EXAMPLE_ROOT, "vite.config.ts"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve Vite dev server address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe("board local-mcp integration", () => {
  let server: ViteDevServer | undefined;
  let client: McpTestClient | undefined;
  let userDataDir: string | undefined;

  beforeAll(async () => {
    const startedServer = await startExampleServer();
    server = startedServer.server;
    userDataDir = await mkdtemp(resolve(tmpdir(), "webmcp-bridge-board-"));
    client = new McpTestClient(startedServer.url, userDataDir);
    const bridgeHandle = await client.start();
    expect(bridgeHandle.mode).toBe("native");
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it(
    "lists native board tools through local-mcp",
    async () => {
      const response = await waitFor(
        async () => await client!.request("tools/list", {}),
        (candidate) => {
          const result = readResult(candidate);
          const tools = Array.isArray(result.tools) ? result.tools : [];
          return tools.some((tool) => {
            return (
              typeof tool === "object" &&
              tool !== null &&
              "name" in tool &&
              tool.name === "nodes.upsert"
            );
          });
        },
        20_000,
      );

      const tools = readResult(response).tools as Array<Record<string, unknown>>;
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "nodes.list",
          "nodes.upsert",
          "edges.list",
          "edges.upsert",
          "layout.apply",
          "diagram.export",
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "creates a node through local-mcp and reads it back from the app",
    async () => {
      const before = readStructuredContent(await client!.request("tools/call", { name: "nodes.list", arguments: {} }));
      const beforeItems = Array.isArray(before.items) ? before.items : [];
      const testLabel = `Inventory API ${Date.now()}`;

      await client!.request("tools/call", {
        name: "nodes.upsert",
        arguments: {
          nodes: [
            {
              label: testLabel,
              kind: "service",
              x: 1520,
              y: 260,
            },
          ],
        },
      });

      const afterResponse = await waitFor(
        async () => readStructuredContent(await client!.request("tools/call", { name: "nodes.list", arguments: {} })),
        (candidate) => {
          const items = Array.isArray(candidate.items) ? candidate.items : [];
          return items.some((item) => {
            return (
              typeof item === "object" &&
              item !== null &&
              "label" in item &&
              item.label === testLabel
            );
          });
        },
        15_000,
      );

      const afterItems = Array.isArray(afterResponse.items) ? afterResponse.items : [];
      expect(afterItems).toHaveLength(beforeItems.length + 1);
      expect(afterItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: testLabel,
            kind: "service",
          }),
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves existing edges when nodes are updated through local-mcp",
    async () => {
      await client!.request("tools/call", {
        name: "diagram.reset",
        arguments: {},
      });

      await client!.request("tools/call", {
        name: "nodes.upsert",
        arguments: {
          nodes: [
            { id: "left", label: "Left", kind: "service", x: 120, y: 120 },
            { id: "right", label: "Right", kind: "service", x: 520, y: 120 },
          ],
        },
      });

      await client!.request("tools/call", {
        name: "edges.upsert",
        arguments: {
          edges: [
            { id: "edge-1", sourceNodeId: "left", targetNodeId: "right", protocol: "sync" },
          ],
        },
      });

      await client!.request("tools/call", {
        name: "nodes.upsert",
        arguments: {
          nodes: [
            { id: "left", label: "Left", kind: "service", x: 180, y: 180 },
          ],
        },
      });

      const edges = await waitFor(
        async () => readStructuredContent(await client!.request("tools/call", { name: "edges.list", arguments: {} })),
        (candidate) => {
          const items = Array.isArray(candidate.items) ? candidate.items : [];
          return items.some((item) => {
            return (
              typeof item === "object" &&
              item !== null &&
              "id" in item &&
              item.id === "edge-1"
            );
          });
        },
        15_000,
      );

      expect(edges.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "edge-1",
            sourceNodeId: "left",
            targetNodeId: "right",
          }),
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
