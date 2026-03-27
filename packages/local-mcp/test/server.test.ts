/**
 * This module tests local-mcp stdio server MCP method handling with a gateway stub.
 * It depends on newline-delimited JSON-RPC framing and server APIs to validate MCP SDK stdio request/response behavior.
 */

import { PassThrough } from "node:stream";
import type { JsonValue } from "@webmcp-bridge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpJsonRpcResponse } from "../src/mcp-types.js";
import {
  createLocalMcpStdioServer,
  type LocalBridgeControl,
  type LocalMcpGateway,
  type LocalBridgeState,
  type LocalMcpStdioServer,
} from "../src/server.js";

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createLocalMcpStdioServer", () => {
  let input: PassThrough;
  let output: PassThrough;
  let server: LocalMcpStdioServer;
  const frames: Array<Record<string, unknown>> = [];
  let outputBuffer = "";

  type GatewayReadResourcePayload = {
    version: number;
    items: Array<{
      id: string;
      body: string;
    }>;
  };

  const listTools = vi.fn<LocalMcpGateway["listTools"]>(async () => [
    {
      name: "ping",
      description: "ping",
    },
  ]);
  const callTool = vi.fn<LocalMcpGateway["callTool"]>(
    async (name: string): Promise<JsonValue> => ({ ok: true, name }),
  );
  const listResources = vi.fn<LocalMcpGateway["listResources"]>(async () => [
    {
      uri: "board://local/interactions",
      name: "Board Interactions",
      mimeType: "application/json",
    },
  ]);
  const readResource = vi.fn<(uri: string) => Promise<GatewayReadResourcePayload>>(async () => ({
    version: 1,
    items: [],
  }));
  const onResourceUpdated = vi.fn<LocalMcpGateway["onResourceUpdated"]>(() => () => {});

  const gateway = {
    listTools,
    callTool,
    listResources,
    readResource,
    onResourceUpdated,
  } satisfies LocalMcpGateway;
  const getState = vi.fn<LocalBridgeControl["getState"]>(() => ({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "launch" as const,
      authPolicyMode: "none" as const,
      authState: "unknown" as const,
      sessionState: "runtime_active" as const,
      ownership: "managed" as const,
      mode: "native" as const,
      presentationMode: "headed" as const,
      preferredPresentationMode: "headed" as const,
    }));
  const openWindow = vi.fn<LocalBridgeControl["openWindow"]>(async () => "focused" as const);
  const bootstrapSession = vi.fn<LocalBridgeControl["bootstrapSession"]>(async () => ({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "bootstrap" as const,
      authPolicyMode: "bootstrap_then_attach" as const,
      authState: "auth_required" as const,
      sessionState: "bootstrap_active" as const,
      ownership: "external" as const,
      mode: "control-only" as const,
      presentationMode: "headed" as const,
      preferredPresentationMode: "headed" as const,
      profilePath: "/tmp/board-profile",
    }));
  const attachSession = vi.fn<LocalBridgeControl["attachSession"]>(async () => ({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "attach" as const,
      browserUrl: "http://127.0.0.1:9222",
      authPolicyMode: "bootstrap_then_attach" as const,
      authState: "authenticated" as const,
      sessionState: "runtime_active" as const,
      ownership: "external" as const,
      mode: "native" as const,
      presentationMode: "headed" as const,
      preferredPresentationMode: "headed" as const,
    }));
  const getPresentationMode = vi.fn<LocalBridgeControl["getPresentationMode"]>(() => "headed" as const);
  const setPresentationMode = vi.fn<LocalBridgeControl["setPresentationMode"]>(async () => ({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "launch" as const,
      authPolicyMode: "none" as const,
      authState: "authenticated" as const,
      sessionState: "runtime_active" as const,
      ownership: "managed" as const,
      mode: "native" as const,
      presentationMode: "headless" as const,
      preferredPresentationMode: "headless" as const,
    }));
  const resetProfile = vi.fn<LocalBridgeControl["resetProfile"]>(async () => ({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "bootstrap" as const,
      authPolicyMode: "bootstrap_then_attach" as const,
      authState: "unknown" as const,
      sessionState: "bootstrap_active" as const,
      ownership: "external" as const,
      mode: "control-only" as const,
      presentationMode: "headed" as const,
      preferredPresentationMode: "headed" as const,
      profilePath: "/tmp/board-profile",
      lastBackupPath: "/tmp/board-profile-backup",
    }));
  const closeBridge = vi.fn<LocalBridgeControl["closeBridge"]>(async () => {});
  const bridgeControl = {
    getState,
    openWindow,
    bootstrapSession,
    attachSession,
    getPresentationMode,
    setPresentationMode,
    resetProfile,
    closeBridge,
  } satisfies LocalBridgeControl;

  beforeEach(async () => {
    input = new PassThrough();
    output = new PassThrough();
    frames.length = 0;
    outputBuffer = "";
    listTools.mockClear();
    callTool.mockClear();
    listResources.mockClear();
    readResource.mockClear();
    onResourceUpdated.mockClear();
    getState.mockClear();
    openWindow.mockClear();
    bootstrapSession.mockClear();
    attachSession.mockClear();
    getPresentationMode.mockClear();
    setPresentationMode.mockClear();
    resetProfile.mockClear();
    closeBridge.mockClear();

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

    server = createLocalMcpStdioServer({
      gateway,
      bridgeControl,
      serviceVersion: "0.1.0-test",
      input,
      output,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    output.removeAllListeners();
    input.end();
    output.end();
  });

  async function request(payload: Record<string, unknown>): Promise<McpJsonRpcResponse> {
    const requestId = payload.id;
    const beforeCount = frames.length;
    input.write(`${JSON.stringify(payload)}\n`);
    await waitFor(() =>
      frames.slice(beforeCount).some((frame) => {
        return "id" in frame && frame.id === requestId;
      }),
    );
    const response = frames
      .slice(beforeCount)
      .find((frame) => "id" in frame && frame.id === requestId) as McpJsonRpcResponse | undefined;
    if (!response) {
      throw new Error("response frame not found");
    }
    return response;
  }

  it("responds to initialize", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "0.1.0-test",
        },
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "webmcp-bridge-local-mcp",
      },
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          subscribe: true,
        },
      },
    });
  });

  it("proxies tools/list to gateway", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2",
      method: "tools/list",
      params: {},
    });

    expect(listTools).toHaveBeenCalledOnce();
    expect("result" in response ? response.result : undefined).toMatchObject({
      tools: [
        { name: "bridge.window.open" },
        { name: "bridge.session.status" },
        { name: "bridge.session.bootstrap" },
        { name: "bridge.session.attach" },
        { name: "bridge.session.mode.get" },
        { name: "bridge.session.mode.set" },
        { name: "bridge.session.stop" },
        { name: "bridge.session.reset_profile" },
        { name: "bridge.open" },
        { name: "bridge.close" },
        { name: "ping" },
      ],
    });
  });

  it("adds bridge-only recovery guidance when no page tools are attached", async () => {
    listTools.mockResolvedValueOnce([]);

    const response = await request({
      jsonrpc: "2.0",
      id: "2-tools-empty",
      method: "tools/list",
      params: {},
    });

    const tools =
      "result" in response
        ? ((response.result as { tools?: Array<{ name: string; description?: string }> }).tools ?? [])
        : [];
    const statusTool = tools.find((tool) => tool.name === "bridge.session.status");
    const attachTool = tools.find((tool) => tool.name === "bridge.session.attach");

    expect(statusTool?.description).toContain("Only bridge.* tools are currently available");
    expect(statusTool?.description).toContain("Call bridge.session.status first");
    expect(attachTool?.description).toContain("bridge.session.attach");
  });

  it("tells bootstrap sessions to finish sign-in before attaching when only bridge tools are available", async () => {
    listTools.mockResolvedValueOnce([]);
    const bootstrapState: LocalBridgeState = {
      site: "google",
      targetUrl: "https://gemini.google.com/app",
      controlMode: "bootstrap",
      authPolicyMode: "bootstrap_then_attach",
      authState: "auth_required",
      sessionState: "bootstrap_active",
      ownership: "external",
      mode: "control-only",
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      profilePath: "/tmp/google-profile",
      browserPid: 1234,
    };
    bridgeControl.getState.mockReturnValueOnce(bootstrapState);

    const response = await request({
      jsonrpc: "2.0",
      id: "2-tools-bootstrap",
      method: "tools/list",
      params: {},
    });

    const tools =
      "result" in response
        ? ((response.result as { tools?: Array<{ name: string; description?: string }> }).tools ?? [])
        : [];
    const bootstrapTool = tools.find((tool) => tool.name === "bridge.session.bootstrap");

    expect(bootstrapTool?.description).toContain("complete sign-in in the bootstrap browser, then call bridge.session.attach");
  });

  it("handles bridge.window.open locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2a",
      method: "tools/call",
      params: {
        name: "bridge.window.open",
        arguments: {},
      },
    });

    expect(bridgeControl.openWindow).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        site: "board",
        targetUrl: "http://127.0.0.1:4173",
        controlMode: "launch",
        mode: "native",
        presentationMode: "headed",
        preferredPresentationMode: "headed",
        windowState: "focused",
      },
    });
  });

  it("handles bridge.open locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2b",
      method: "tools/call",
      params: {
        name: "bridge.open",
        arguments: {},
      },
    });

    expect(bridgeControl.openWindow).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        site: "board",
        targetUrl: "http://127.0.0.1:4173",
        controlMode: "launch",
        mode: "native",
        presentationMode: "headed",
        preferredPresentationMode: "headed",
        windowState: "focused",
      },
    });
  });

  it("passes through bridge.open reopened state", async () => {
    bridgeControl.openWindow.mockResolvedValueOnce("opened");

    const response = await request({
      jsonrpc: "2.0",
      id: "2bb",
      method: "tools/call",
      params: {
        name: "bridge.open",
        arguments: {},
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        windowState: "opened",
      },
    });
  });

  it("returns bridge.session.status locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc",
      method: "tools/call",
      params: {
        name: "bridge.session.status",
        arguments: {},
      },
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(bridgeControl.openWindow).not.toHaveBeenCalled();
    expect(bridgeControl.closeBridge).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        session: {
          site: "board",
          targetUrl: "http://127.0.0.1:4173",
          controlMode: "launch",
          mode: "native",
          presentationMode: "headed",
          preferredPresentationMode: "headed",
        },
      },
    });
  });

  it("maps bridge.open headless failures to structured errors", async () => {
    bridgeControl.openWindow.mockRejectedValueOnce(
      new Error(
        "UNSUPPORTED_IN_HEADLESS_SESSION: bridge.open requires a headed local-mcp session. Start the bridge with --no-headless.",
      ),
    );

    const response = await request({
      jsonrpc: "2.0",
      id: "2c",
      method: "tools/call",
      params: {
        name: "bridge.open",
        arguments: {},
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: false,
        error: {
          code: "UNSUPPORTED_IN_HEADLESS_SESSION",
        },
      },
    });
    expect("result" in response ? response.result?.content : undefined).toEqual([]);
    expect("result" in response ? response.result?.isError : undefined).toBe(true);
  });

  it("handles bridge.session.attach locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2cd",
      method: "tools/call",
      params: {
        name: "bridge.session.attach",
        arguments: {
          browserUrl: "http://127.0.0.1:9222",
        },
      },
    });

    expect(bridgeControl.attachSession).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        restarted: true,
        session: {
          controlMode: "attach",
          browserUrl: "http://127.0.0.1:9222",
        },
      },
    });
  });

  it("allows bridge.session.attach without an explicit browserUrl", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2ce",
      method: "tools/call",
      params: {
        name: "bridge.session.attach",
        arguments: {},
      },
    });

    expect(bridgeControl.attachSession).toHaveBeenCalledWith(undefined);
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        restarted: true,
        session: {
          controlMode: "attach",
        },
      },
    });
  });

  it("handles bridge.session.bootstrap locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2ce-bootstrap",
      method: "tools/call",
      params: {
        name: "bridge.session.bootstrap",
        arguments: {},
      },
    });

    expect(bridgeControl.bootstrapSession).toHaveBeenCalledOnce();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        bootstrapped: true,
        session: {
          controlMode: "bootstrap",
          sessionState: "bootstrap_active",
        },
      },
    });
  });

  it("returns bridge.session.mode.get locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2cf",
      method: "tools/call",
      params: {
        name: "bridge.session.mode.get",
        arguments: {},
      },
    });

    expect(bridgeControl.getPresentationMode).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        presentationMode: "headed",
      },
    });
  });

  it("handles bridge.session.mode.set locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2cf-set",
      method: "tools/call",
      params: {
        name: "bridge.session.mode.set",
        arguments: {
          mode: "headless",
        },
      },
    });

    expect(bridgeControl.setPresentationMode).toHaveBeenCalledWith({
      presentationMode: "headless",
    });
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        updated: true,
        presentationMode: "headless",
        session: {
          controlMode: "launch",
          presentationMode: "headless",
          preferredPresentationMode: "headless",
        },
      },
    });
  });

  it("handles bridge.session.reset_profile locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2cf-reset",
      method: "tools/call",
      params: {
        name: "bridge.session.reset_profile",
        arguments: {},
      },
    });

    expect(bridgeControl.resetProfile).toHaveBeenCalledOnce();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        reset: true,
        session: {
          lastBackupPath: "/tmp/board-profile-backup",
        },
      },
    });
  });

  it("maps non-prefixed bridge control errors to a stable default code", async () => {
    bridgeControl.setPresentationMode.mockRejectedValueOnce(new Error("plain restart failure"));

    const response = await request({
      jsonrpc: "2.0",
      id: "2cg",
      method: "tools/call",
      params: {
        name: "bridge.session.mode.set",
        arguments: {
          mode: "headless",
        },
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: false,
        error: {
          code: "BRIDGE_CONTROL_FAILED",
          message: "plain restart failure",
        },
      },
    });
  });

  it("handles bridge.close locally and closes asynchronously", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2d",
      method: "tools/call",
      params: {
        name: "bridge.close",
        arguments: {},
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        site: "board",
        controlMode: "launch",
        closing: true,
      },
    });
    await waitFor(() => bridgeControl.closeBridge.mock.calls.length === 1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("handles bridge.session.stop locally and closes asynchronously", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2e",
      method: "tools/call",
      params: {
        name: "bridge.session.stop",
        arguments: {},
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        site: "board",
        controlMode: "launch",
        closing: true,
      },
    });
    await waitFor(() => bridgeControl.closeBridge.mock.calls.length === 1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("proxies tools/call to gateway", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "3",
      method: "tools/call",
      params: {
        name: "ping",
        arguments: {
          ping: true,
        },
      },
    });

    expect(callTool).toHaveBeenCalledWith("ping", { ping: true });
    expect("result" in response ? response.result : undefined).toMatchObject({
      content: [],
      structuredContent: { ok: true, name: "ping" },
    });
  });

  it("passes through MCP CallToolResult payload without remapping", async () => {
    callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    });

    const response = await request({
      jsonrpc: "2.0",
      id: "3b",
      method: "tools/call",
      params: {
        name: "ping",
        arguments: {},
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    });
  });

  it("does not pass through invalid CallToolResult-like payload", async () => {
    callTool.mockResolvedValueOnce({
      structuredContent: "invalid",
    });

    const response = await request({
      jsonrpc: "2.0",
      id: "3c",
      method: "tools/call",
      params: {
        name: "ping",
        arguments: {},
      },
    });

    expect("result" in response ? response.result : undefined).toMatchObject({
      content: [],
      structuredContent: {
        structuredContent: "invalid",
      },
    });
  });

  it("returns method-not-found on unknown method", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "4",
      method: "unknown.method",
    });

    expect("error" in response ? response.error.code : undefined).toBe(-32601);
  });

  it("does not respond to notifications", async () => {
    const beforeCount = frames.length;
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(frames.length).toBe(beforeCount);
  });

  it("proxies resources/list to gateway", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "6",
      method: "resources/list",
      params: {},
    });

    expect(listResources).toHaveBeenCalledOnce();
    expect("result" in response ? response.result : undefined).toMatchObject({
      resources: [{ uri: "board://local/interactions", name: "Board Interactions" }],
    });
  });

  it("proxies resources/read to gateway", async () => {
    readResource.mockResolvedValueOnce({
      version: 1,
      items: [{ id: "interaction-1", body: "Expand selection" }],
    });

    const response = await request({
      jsonrpc: "2.0",
      id: "7",
      method: "resources/read",
      params: {
        uri: "board://local/interactions",
      },
    });

    expect(readResource).toHaveBeenCalledWith("board://local/interactions");
    expect("result" in response ? response.result : undefined).toMatchObject({
      contents: [
        {
          uri: "board://local/interactions",
          mimeType: "application/json",
        },
      ],
    });
    const result =
      "result" in response
        ? (response.result as { contents?: Array<{ text?: string }> })
        : undefined;
    const text = result?.contents?.[0]?.text;
    expect(typeof text).toBe("string");
    expect(String(text)).toContain("Expand selection");
  });

  it("caches resource mime types across repeated reads", async () => {
    readResource.mockResolvedValue({
      version: 1,
      items: [{ id: "interaction-1", body: "Expand selection" }],
    });

    await request({
      jsonrpc: "2.0",
      id: "7-cache-1",
      method: "resources/read",
      params: {
        uri: "board://local/interactions",
      },
    });

    await request({
      jsonrpc: "2.0",
      id: "7-cache-2",
      method: "resources/read",
      params: {
        uri: "board://local/interactions",
      },
    });

    expect(listResources).toHaveBeenCalledOnce();
    expect(readResource).toHaveBeenCalledTimes(2);
  });

  it("emits resources/updated after a subscribed resource changes", async () => {
    const notifyResourceUpdated = onResourceUpdated.mock.calls[0]?.[0] as
      | ((uri: string) => void)
      | undefined;
    expect(notifyResourceUpdated).toBeTypeOf("function");

    await request({
      jsonrpc: "2.0",
      id: "8-init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          resources: {
            subscribe: true,
          },
        },
        clientInfo: {
          name: "test-client",
          version: "0.1.0-test",
        },
      },
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );

    await request({
      jsonrpc: "2.0",
      id: "8-sub",
      method: "resources/subscribe",
      params: {
        uri: "board://local/interactions",
      },
    });

    notifyResourceUpdated?.("board://local/interactions");

    await waitFor(() =>
      frames.some((frame) => frame.method === "notifications/resources/updated"),
    );
    const notification = frames.find(
      (frame) => frame.method === "notifications/resources/updated",
    );
    expect(notification).toMatchObject({
      params: {
        uri: "board://local/interactions",
      },
    });
  });

  it("emits tools/list_changed after a tool call mutates available tools", async () => {
    listTools.mockResolvedValueOnce([{ name: "navigate", description: "navigate" }]);
    listTools.mockResolvedValueOnce([
      { name: "navigate", description: "navigate" },
      { name: "search_entities", description: "search entities" },
    ]);

    await request({
      jsonrpc: "2.0",
      id: "5-init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
        clientInfo: {
          name: "test-client",
          version: "0.1.0-test",
        },
      },
    });

    await request({
      jsonrpc: "2.0",
      id: "5",
      method: "tools/call",
      params: {
        name: "navigate",
        arguments: {
          to: "/entities",
        },
      },
    });

    const listChangedNotification = frames.find(
      (frame) => frame.method === "notifications/tools/list_changed",
    );
    expect(listChangedNotification).toBeDefined();
  });
});
