/**
 * This module exercises the local-mcp bridge against a live Weibo browser session.
 * It depends on the bridge source entrypoint and stdio framing helpers so attach-mode MCP calls can be validated end to end.
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { McpJsonRpcResponse } from "../src/mcp-types.js";
import { startLocalMcpBridge, type LocalMcpBridgeHandle } from "../src/bridge.js";

const RUN_LIVE = process.env.RUN_WEIBO_LIVE === "1";
const BROWSER_URL = process.env.WEIBO_BROWSER_URL ?? "http://127.0.0.1:9222";
const SEARCH_QUERY = process.env.WEIBO_QUERY ?? "OpenAI";
const USER_DATA_DIR = process.env.WEIBO_USER_DATA_DIR ?? "/tmp/webmcp-weibo-bootstrap";
const USER_UID = process.env.WEIBO_UID ?? "1648815335";

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timeout waiting for MCP response");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("live Weibo bridge smoke", () => {
  let handle: LocalMcpBridgeHandle | undefined;
  let input: PassThrough | undefined;
  let output: PassThrough | undefined;

  afterEach(async () => {
    await handle?.close();
    input?.end();
    output?.end();
  });

  it.runIf(RUN_LIVE)("attaches to a real browser session and serves Weibo tools over MCP", async () => {
    input = new PassThrough();
    output = new PassThrough();

    const frames: Array<Record<string, unknown>> = [];
    let outputBuffer = "";
    output.on("data", (chunk: Buffer | string) => {
      outputBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        frames.push(JSON.parse(trimmed) as Record<string, unknown>);
      }
    });

    handle = await startLocalMcpBridge({
      site: "weibo",
      browserUrl: BROWSER_URL,
      userDataDir: USER_DATA_DIR,
      serviceVersion: "0.1.0-live",
      input,
      output,
      onError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
    });

    async function request(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<McpJsonRpcResponse> {
      const requestId = payload.id;
      const beforeCount = frames.length;
      input!.write(`${JSON.stringify(payload)}\n`);
      await waitFor(() => frames.slice(beforeCount).some((frame) => "id" in frame && frame.id === requestId), timeoutMs);
      const response = frames
        .slice(beforeCount)
        .find((frame) => "id" in frame && frame.id === requestId) as McpJsonRpcResponse | undefined;
      if (!response) {
        throw new Error(`response not found for request id ${String(requestId)}`);
      }
      return response;
    }

    await request({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "live-weibo-smoke",
          version: "0.1.0-live",
        },
      },
    });

    const toolListResponse = await request({
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
      params: {},
    });
    const toolList = "result" in toolListResponse
      ? (toolListResponse.result?.tools as Array<{ name?: string }> | undefined) ?? []
      : [];
    expect(toolList.some((tool) => tool.name === "timeline.home.list")).toBe(true);
    expect(toolList.some((tool) => tool.name === "search.ai.summary")).toBe(true);

    const authResponse = await request({
      jsonrpc: "2.0",
      id: "auth",
      method: "tools/call",
      params: {
        name: "auth.get",
        arguments: {},
      },
    });
    const authContent = "result" in authResponse
      ? (authResponse.result?.structuredContent as { state?: string } | undefined)
      : undefined;
    expect(authContent?.state).toBe("authenticated");

    const timelineResponse = await request({
      jsonrpc: "2.0",
      id: "timeline",
      method: "tools/call",
      params: {
        name: "timeline.home.list",
        arguments: {
          limit: 3,
        },
      },
    }, 60_000);
    const timelineContent = "result" in timelineResponse
      ? (timelineResponse.result?.structuredContent as {
          items?: Array<{ id?: string; authorUrl?: string }>;
          source?: string;
          reason?: string;
        } | undefined)
      : undefined;
    expect(
      timelineContent?.source === "network" ||
      timelineContent?.source === "dom",
    ).toBe(true);

    const searchResponse = await request({
      jsonrpc: "2.0",
      id: "search-weibo",
      method: "tools/call",
      params: {
        name: "search.weibo",
        arguments: {
          query: SEARCH_QUERY,
          limit: 3,
        },
      },
    }, 60_000);
    const searchContent = "result" in searchResponse
      ? (searchResponse.result?.structuredContent as {
          items?: Array<{ id?: string; authorUrl?: string }>;
          nextCursor?: string;
        } | undefined)
      : undefined;
    expect(Array.isArray(searchContent?.items ?? [])).toBe(true);
    expect(
      searchContent?.nextCursor === undefined ||
      (typeof searchContent.nextCursor === "string" && searchContent.nextCursor.length > 0),
    ).toBe(true);

    const userResponse = await request({
      jsonrpc: "2.0",
      id: "user",
      method: "tools/call",
      params: {
        name: "user.get",
        arguments: {
          url: `https://weibo.com/u/${USER_UID}`,
        },
      },
    }, 60_000);
    const userContent = "result" in userResponse
      ? (userResponse.result?.structuredContent as { user?: { id?: string; screenName?: string }; source?: string } | undefined)
      : undefined;
    expect(userContent).toBeTruthy();
    expect(
      userContent?.source === undefined ||
      userContent?.source === "network" ||
      userContent?.source === "dom",
    ).toBe(true);
    if (userContent?.user) {
      expect(userContent.user.id).toBe(USER_UID);
    }

    const userPostsResponse = await request({
      jsonrpc: "2.0",
      id: "user-posts",
      method: "tools/call",
      params: {
        name: "user.posts.list",
        arguments: {
          uid: USER_UID,
          cursor: "1",
        },
      },
    }, 60_000);
    const userPostsContent = "result" in userPostsResponse
      ? (userPostsResponse.result?.structuredContent as {
          items?: Array<{ id?: string }>;
          source?: string;
          nextCursor?: string;
        } | undefined)
      : undefined;
    expect(userPostsContent?.source).toBe("network");
    expect((userPostsContent?.items?.length ?? 0) > 0).toBe(true);
    expect(typeof userPostsContent?.nextCursor === "string" && userPostsContent.nextCursor.length > 0).toBe(true);

    const latestUserPostId = userPostsContent?.items?.find((item) => item.id)?.id;
    expect(latestUserPostId).toBeTruthy();

    const postResponse = await request({
      jsonrpc: "2.0",
      id: "post",
      method: "tools/call",
      params: {
        name: "post.get",
        arguments: {
          id: latestUserPostId,
        },
      },
    }, 60_000);
    const postContent = "result" in postResponse
      ? (postResponse.result?.structuredContent as { post?: { id?: string }; source?: string } | undefined)
      : undefined;
    expect(postContent?.source).toBe("network");
    expect(postContent?.post?.id).toBe(latestUserPostId);

    const aiResponse = await request({
      jsonrpc: "2.0",
      id: "search-ai",
      method: "tools/call",
      params: {
        name: "search.ai.summary",
        arguments: {
          query: SEARCH_QUERY,
        },
      },
    }, 60_000);
    const aiContent = "result" in aiResponse
      ? (aiResponse.result?.structuredContent as {
          source?: string;
          query?: string;
          summary?: string;
          reason?: string;
        } | undefined)
      : undefined;
    expect(aiContent?.source).toBe("network");
    expect(aiContent?.query).toBe(SEARCH_QUERY);
    expect(aiContent?.summary || aiContent?.reason === "summary_unavailable").toBeTruthy();
  }, 180_000);
});
