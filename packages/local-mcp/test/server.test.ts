/**
 * This module tests local-mcp stdio server MCP method handling with a gateway stub.
 * It depends on newline-delimited JSON-RPC framing and server APIs to validate MCP SDK stdio request/response behavior.
 */

import { PassThrough } from "node:stream";
import type { JsonValue } from "@webmcp-bridge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpJsonRpcResponse,
  McpLifecycleContractResult,
  McpLifecycleSnapshot,
} from "../src/mcp-types.js";
import {
  createLocalMcpStdioServer,
  type LocalMcpGateway,
  type LocalMcpStdioServer,
} from "../src/server.js";

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
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
  const readResource = vi.fn<
    (uri: string) => Promise<GatewayReadResourcePayload>
  >(async () => ({
    version: 1,
    items: [],
  }));
  const onResourceUpdated = vi.fn<LocalMcpGateway["onResourceUpdated"]>(
    () => () => {},
  );
  let lifecycleChangedListener: (() => void) | undefined;
  let toolsetChangedListener: (() => void) | undefined;

  const gateway = {
    listTools,
    callTool,
    listResources,
    readResource,
    onResourceUpdated,
  } satisfies LocalMcpGateway;
  const bridgeControl = {
    getState: vi.fn(() => ({
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
    })),
    openWindow: vi.fn<() => Promise<"focused" | "opened">>(
      async () => "focused" as const,
    ),
    bootstrapSession: vi.fn(async () => ({
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
    })),
    attachSession: vi.fn(async () => ({
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
    })),
    debugEval: vi.fn(async () => ({ ok: true, source: "debug" })),
    listOverlays: vi.fn(async () => ({
      overlays: [],
      persistence: {
        available: true,
        profilePath: "/tmp/board-profile",
      },
    })),
    installOverlay: vi.fn(async () => ({
      id: "x-dom",
      siteId: "board",
      enabled: true,
      activation: "namespaced" as const,
      tools: [],
      createdAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z",
    })),
    updateOverlay: vi.fn(async () => ({
      id: "x-dom",
      siteId: "board",
      enabled: true,
      activation: "namespaced" as const,
      tools: [],
      createdAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z",
    })),
    enableOverlay: vi.fn(async () => ({
      id: "x-dom",
      siteId: "board",
      enabled: true,
      activation: "namespaced" as const,
      tools: [],
      createdAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z",
    })),
    disableOverlay: vi.fn(async () => ({
      id: "x-dom",
      siteId: "board",
      enabled: false,
      activation: "namespaced" as const,
      tools: [],
      createdAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z",
    })),
    deleteOverlay: vi.fn(async () => {}),
    exportOverlay: vi.fn(async () => ({
      overlay: {
        id: "board_fix",
        siteId: "board",
        enabled: true,
        activation: "override" as const,
        tools: [],
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:00.000Z",
      },
      format: "adapter-draft" as const,
      outputDir: "/tmp/board-profile/.webmcp-bridge/exports/board_fix",
      entryFile:
        "/tmp/board-profile/.webmcp-bridge/exports/board_fix/src/index.ts",
      files: [
        "/tmp/board-profile/.webmcp-bridge/exports/board_fix/src/index.ts",
      ],
    })),
    getPresentationMode: vi.fn(() => "headed" as const),
    setPresentationMode: vi.fn(async () => ({
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
    })),
    resetProfile: vi.fn(async () => ({
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
    })),
    closeBridge: vi.fn(async () => {}),
  };
  type BridgeState = ReturnType<typeof bridgeControl.getState>;

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
    bridgeControl.getState.mockClear();
    bridgeControl.openWindow.mockClear();
    bridgeControl.bootstrapSession.mockClear();
    bridgeControl.attachSession.mockClear();
    bridgeControl.debugEval.mockClear();
    bridgeControl.listOverlays.mockClear();
    bridgeControl.installOverlay.mockClear();
    bridgeControl.updateOverlay.mockClear();
    bridgeControl.enableOverlay.mockClear();
    bridgeControl.disableOverlay.mockClear();
    bridgeControl.deleteOverlay.mockClear();
    bridgeControl.getPresentationMode.mockClear();
    bridgeControl.setPresentationMode.mockClear();
    bridgeControl.resetProfile.mockClear();
    bridgeControl.closeBridge.mockClear();

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
      onLifecycleMayHaveChanged: (listener) => {
        lifecycleChangedListener = listener;
        return () => {
          if (lifecycleChangedListener === listener) {
            lifecycleChangedListener = undefined;
          }
        };
      },
      onToolsetMayHaveChanged: (listener) => {
        toolsetChangedListener = listener;
        return () => {
          if (toolsetChangedListener === listener) {
            toolsetChangedListener = undefined;
          }
        };
      },
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

  async function request(
    payload: Record<string, unknown>,
  ): Promise<McpJsonRpcResponse> {
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
      .find((frame) => "id" in frame && frame.id === requestId) as
      | McpJsonRpcResponse
      | undefined;
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

    expect("result" in response ? response.result : undefined).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "webmcp-bridge-local-mcp",
      },
      instructions: expect.stringContaining(
        "If help only shows bridge.* tools",
      ),
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

  it("sends tools/list_changed when the bridge runtime changes the toolset", async () => {
    await request({
      jsonrpc: "2.0",
      id: "init-1",
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
    listTools.mockResolvedValueOnce([
      {
        name: "ping",
        description: "ping",
      },
    ]);
    await request({
      jsonrpc: "2.0",
      id: "tools-1",
      method: "tools/list",
      params: {},
    });

    listTools.mockResolvedValueOnce([
      {
        name: "ping",
        description: "ping",
      },
      {
        name: "pong",
        description: "pong",
      },
    ]);

    const beforeCount = frames.length;
    toolsetChangedListener?.();

    await waitFor(() =>
      frames
        .slice(beforeCount)
        .some((frame) => frame.method === "notifications/tools/list_changed"),
    );

    expect(frames.slice(beforeCount)).toContainEqual(
      expect.objectContaining({
        method: "notifications/tools/list_changed",
      }),
    );
  });

  it("reports a stateful lifecycle contract", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "1-lifecycle-contract",
      method: "uxc/lifecycle_contract",
      params: {},
    });

    expect(
      "result" in response
        ? (response.result as McpLifecycleContractResult)
        : undefined,
    ).toEqual({
      reap_policy: "stateful",
    });
  });

  it("emits an initial interactive lifecycle snapshot after initialized", async () => {
    await request({
      jsonrpc: "2.0",
      id: "2-init",
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

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );

    await waitFor(() =>
      frames.some(
        (frame) => frame.method === "notifications/uxc.lifecycle_changed",
      ),
    );
    const notification = frames.find(
      (frame) => frame.method === "notifications/uxc.lifecycle_changed",
    );
    expect(notification?.params).toMatchObject({
      auto_reap_allowed: false,
      retention_reason: "interactive",
      retry_after_secs: 30,
    } satisfies Partial<McpLifecycleSnapshot>);
    expect(
      (notification?.params as McpLifecycleSnapshot | undefined)
        ?.updated_at_unix,
    ).toBeTypeOf("number");
  });

  it("emits a waiting_for_human lifecycle snapshot for bootstrap state", async () => {
    bridgeControl.getState.mockReturnValueOnce({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "bootstrap",
      authPolicyMode: "bootstrap_then_attach",
      authState: "auth_required",
      sessionState: "bootstrap_active",
      ownership: "external",
      mode: "control-only",
      presentationMode: "headed",
      preferredPresentationMode: "headed",
      profilePath: "/tmp/board-profile",
    } as unknown as BridgeState);

    await request({
      jsonrpc: "2.0",
      id: "2a-init",
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

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );

    await waitFor(() =>
      frames.some(
        (frame) => frame.method === "notifications/uxc.lifecycle_changed",
      ),
    );
    const notification = frames.find(
      (frame) => frame.method === "notifications/uxc.lifecycle_changed",
    );
    expect(notification?.params).toMatchObject({
      auto_reap_allowed: false,
      retention_reason: "waiting_for_human",
      retry_after_secs: 30,
    } satisfies Partial<McpLifecycleSnapshot>);
  });

  it("emits lifecycle updates when lifecycle listener reports auto-reapable state", async () => {
    await request({
      jsonrpc: "2.0",
      id: "3-init",
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

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );
    await waitFor(() =>
      frames.some(
        (frame) => frame.method === "notifications/uxc.lifecycle_changed",
      ),
    );

    bridgeControl.getState.mockReturnValueOnce({
      site: "board",
      targetUrl: "http://127.0.0.1:4173",
      controlMode: "launch",
      authPolicyMode: "none",
      authState: "authenticated",
      sessionState: "runtime_active",
      ownership: "managed",
      mode: "native",
      presentationMode: "headless",
      preferredPresentationMode: "headless",
      browserPid: 4321,
    } as unknown as BridgeState);

    const beforeCount = frames.length;
    lifecycleChangedListener?.();

    await waitFor(() =>
      frames
        .slice(beforeCount)
        .some(
          (frame) => frame.method === "notifications/uxc.lifecycle_changed",
        ),
    );
    const notification = frames
      .slice(beforeCount)
      .find((frame) => frame.method === "notifications/uxc.lifecycle_changed");
    expect(notification?.params).toMatchObject({
      auto_reap_allowed: true,
    } satisfies Partial<McpLifecycleSnapshot>);
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
        { name: "bridge.debug.eval" },
        { name: "bridge.overlay.list" },
        { name: "bridge.overlay.install" },
        { name: "bridge.overlay.update" },
        { name: "bridge.overlay.enable" },
        { name: "bridge.overlay.disable" },
        { name: "bridge.overlay.delete" },
        { name: "bridge.overlay.export" },
        { name: "bridge.open" },
        { name: "bridge.close" },
        { name: "ping" },
      ],
    });
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

  it("handles bridge.debug.eval locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-debug",
      method: "tools/call",
      params: {
        name: "bridge.debug.eval",
        arguments: {
          script: "(args) => ({ query: args.query, ok: true })",
          args: {
            query: "openai",
          },
        },
      },
    });

    expect(bridgeControl.debugEval).toHaveBeenCalledWith(
      "(args) => ({ query: args.query, ok: true })",
      { query: "openai" },
    );
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        value: {
          ok: true,
          source: "debug",
        },
      },
    });
  });

  it("lists overlays locally", async () => {
    bridgeControl.listOverlays.mockResolvedValueOnce({
      overlays: [
        {
          id: "board_fix",
          siteId: "board",
          enabled: true,
          tools: [
            {
              name: "diagram.get",
              script: "() => ({ ok: true })",
            },
          ],
          createdAt: "2026-04-06T00:00:00.000Z",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
      ],
      persistence: {
        available: true,
        profilePath: "/tmp/board-profile",
      },
    } as Awaited<ReturnType<typeof bridgeControl.listOverlays>>);

    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-overlays",
      method: "tools/call",
      params: {
        name: "bridge.overlay.list",
        arguments: {},
      },
    });

    expect(bridgeControl.listOverlays).toHaveBeenCalledOnce();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        overlays: [
          {
            id: "board_fix",
            enabled: true,
          },
        ],
        persistence: {
          available: true,
          profilePath: "/tmp/board-profile",
        },
      },
    });
  });

  it("installs overlays locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-install",
      method: "tools/call",
      params: {
        name: "bridge.overlay.install",
        arguments: {
          id: "board_fix",
          description: "Board fallback",
          tools: [
            {
              name: "diagram.get",
              script: "() => ({ ok: true })",
            },
          ],
          activation: "override",
        },
      },
    });

    expect(bridgeControl.installOverlay).toHaveBeenCalledWith({
      id: "board_fix",
      description: "Board fallback",
      activation: "override",
      tools: [
        {
          name: "diagram.get",
          script: "() => ({ ok: true })",
        },
      ],
    });
    expect(callTool).not.toHaveBeenCalled();
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        installed: true,
        overlay: {
          id: "x-dom",
        },
      },
    });
  });

  it("updates overlays locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-update",
      method: "tools/call",
      params: {
        name: "bridge.overlay.update",
        arguments: {
          id: "board_fix",
          enabled: false,
          tools: [
            {
              name: "diagram.get",
              script: "() => ({ ok: true, updated: true })",
            },
          ],
          activation: "override",
        },
      },
    });

    expect(bridgeControl.updateOverlay).toHaveBeenCalledWith({
      id: "board_fix",
      enabled: false,
      activation: "override",
      tools: [
        {
          name: "diagram.get",
          script: "() => ({ ok: true, updated: true })",
        },
      ],
    });
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        updated: true,
        overlay: {
          id: "x-dom",
        },
      },
    });
  });

  it("exports overlays locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-export",
      method: "tools/call",
      params: {
        name: "bridge.overlay.export",
        arguments: {
          id: "board_fix",
        },
      },
    });

    expect(bridgeControl.exportOverlay).toHaveBeenCalledWith("board_fix");
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        exported: true,
        format: "adapter-draft",
        outputDir: "/tmp/board-profile/.webmcp-bridge/exports/board_fix",
      },
    });
  });

  it("enables overlays locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-enable",
      method: "tools/call",
      params: {
        name: "bridge.overlay.enable",
        arguments: {
          id: "board_fix",
        },
      },
    });

    expect(bridgeControl.enableOverlay).toHaveBeenCalledWith("board_fix");
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        enabled: true,
        overlay: {
          id: "x-dom",
          enabled: true,
        },
      },
    });
  });

  it("disables overlays locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-disable",
      method: "tools/call",
      params: {
        name: "bridge.overlay.disable",
        arguments: {
          id: "board_fix",
        },
      },
    });

    expect(bridgeControl.disableOverlay).toHaveBeenCalledWith("board_fix");
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        disabled: true,
        overlay: {
          id: "x-dom",
          enabled: false,
        },
      },
    });
  });

  it("deletes overlays locally", async () => {
    const response = await request({
      jsonrpc: "2.0",
      id: "2bc-delete",
      method: "tools/call",
      params: {
        name: "bridge.overlay.delete",
        arguments: {
          id: "board_fix",
        },
      },
    });

    expect(bridgeControl.deleteOverlay).toHaveBeenCalledWith("board_fix");
    expect("result" in response ? response.result : undefined).toMatchObject({
      structuredContent: {
        ok: true,
        deleted: true,
        id: "board_fix",
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
    expect("result" in response ? response.result?.content : undefined).toEqual(
      [],
    );
    expect("result" in response ? response.result?.isError : undefined).toBe(
      true,
    );
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

    expect(bridgeControl.attachSession).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
    );
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
    bridgeControl.setPresentationMode.mockRejectedValueOnce(
      new Error("plain restart failure"),
    );

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

  it("does not respond to unrelated notifications", async () => {
    const beforeCount = frames.length;
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/example",
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
      resources: [
        { uri: "board://local/interactions", name: "Board Interactions" },
      ],
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
      frames.some(
        (frame) => frame.method === "notifications/resources/updated",
      ),
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
    listTools.mockResolvedValueOnce([
      { name: "navigate", description: "navigate" },
    ]);
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
