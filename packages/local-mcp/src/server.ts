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
  ListResourcesRequestSchema,
  RequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { WebMcpResourceDefinition, WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { McpCanReapResult, McpToolDefinition } from "./mcp-types.js";
import type {
  BridgeAuthState,
  BridgeControlMode,
  BridgePresentationMode,
  BridgeSessionOwnership,
  BridgeSessionState,
} from "./session.js";

export type LocalMcpGateway = {
  listTools: () => Promise<ReadonlyArray<WebMcpToolDefinition>>;
  callTool: (name: string, input: Record<string, unknown>) => Promise<JsonValue>;
  listResources: () => Promise<ReadonlyArray<WebMcpResourceDefinition>>;
  readResource: (uri: string) => Promise<JsonValue>;
  onResourceUpdated: (listener: (uri: string) => void) => () => void;
};

export type LocalBridgeState = {
  site: string;
  targetUrl: string;
  controlMode: BridgeControlMode;
  browserUrl?: string;
  mode: "native" | "polyfill" | "adapter-shim" | "control-only";
  presentationMode: BridgePresentationMode;
  preferredPresentationMode: BridgePresentationMode;
  authPolicyMode: "none" | "bootstrap_then_attach";
  authState: BridgeAuthState;
  sessionState: BridgeSessionState;
  ownership: BridgeSessionOwnership;
  profilePath?: string;
  browserPid?: number;
  lastBackupPath?: string;
};

export type LocalBridgePresentationModeSetOptions = {
  presentationMode: BridgePresentationMode;
};

export type LocalBridgeControl = {
  getState: () => LocalBridgeState;
  openWindow: () => Promise<"focused" | "opened">;
  bootstrapSession: () => Promise<LocalBridgeState>;
  attachSession: (browserUrl?: string) => Promise<LocalBridgeState>;
  getPresentationMode: () => BridgePresentationMode;
  setPresentationMode: (options: LocalBridgePresentationModeSetOptions) => Promise<LocalBridgeState>;
  resetProfile: () => Promise<LocalBridgeState>;
  closeBridge: () => Promise<void>;
};

export type LocalMcpStdioServerOptions = {
  gateway: LocalMcpGateway;
  bridgeControl: LocalBridgeControl;
  serviceVersion: string;
  onToolsetMayHaveChanged?: (listener: () => void) => () => void;
  input?: Readable;
  output?: Writable;
  onError?: (error: unknown) => void;
};

export type LocalMcpStdioServer = {
  start: () => Promise<void>;
  close: () => Promise<void>;
};

const SERVICE_INSTRUCTIONS = [
  "If help only shows bridge.* tools, the site session is not attached to page tools yet.",
  "Call bridge.session.status first.",
  "If the session needs sign-in, call bridge.session.bootstrap and finish login in the browser.",
  "If you already have a signed-in browser or managed profile, call bridge.session.attach.",
  "After attach succeeds, run help again to see site tools.",
].join(" ");
const CAN_REAP_RETRY_AFTER_SECS = 30;

const UxcCanReapRequestSchema = RequestSchema.extend({
  method: z.literal("uxc/can_reap"),
  params: z
    .object({
      idle_for_secs: z.number().int().nonnegative(),
      idle_ttl_secs: z.number().int().nonnegative(),
    })
    .optional(),
});

class LocalMcpStdioServerImpl implements LocalMcpStdioServer {
  private static readonly BRIDGE_CLOSE_DELAY_MS = 100;
  private readonly server: Server;
  private readonly transport: StdioServerTransport;
  private started = false;
  private closed = false;
  private lastToolsSignature: string | undefined;
  private readonly subscribedResourceUris = new Set<string>();
  private readonly resourceMimeTypes = new Map<string, string | undefined>();
  private readonly unsubscribeResourceUpdates: () => void;
  private readonly unsubscribeToolsetChanges: () => void;
  private toolsetNotification = Promise.resolve();

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
          resources: {
            subscribe: true,
          },
        },
        instructions: SERVICE_INSTRUCTIONS,
      },
    );

    this.unsubscribeResourceUpdates = options.gateway.onResourceUpdated((uri) => {
      void this.notifyResourceUpdated(uri);
    });
    this.unsubscribeToolsetChanges =
      options.onToolsetMayHaveChanged?.(() => {
        void this.notifyCurrentToolListChanged(options.gateway);
      }) ?? (() => {});

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.listAllTools(options);
      this.lastToolsSignature = this.computeToolsSignature(tools);
      return {
        tools: tools.map((tool) => this.toMcpToolDefinition(tool)),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const previousSignature = await this.ensureToolsSignature(options.gateway);
      const args = this.normalizeToolArguments(request.params.arguments);
      const toolResult = this.isBridgeToolName(request.params.name)
        ? await this.callBridgeTool(options, request.params.name, args)
        : await options.gateway.callTool(request.params.name, args);
      await this.notifyIfToolsChanged(options.gateway, previousSignature);
      return this.toCallToolResult(toolResult);
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = await this.listResources(options.gateway);
      return {
        resources: resources.map((resource) => this.toMcpResourceDefinition(resource)),
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const resource = await options.gateway.readResource(request.params.uri);
      return {
        contents: [
          this.toMcpResourceContents(
            request.params.uri,
            resource,
            await this.resolveResourceMimeType(options.gateway, request.params.uri),
          ),
        ],
      };
    });

    this.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      this.subscribedResourceUris.add(request.params.uri);
      return {};
    });

    this.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      this.subscribedResourceUris.delete(request.params.uri);
      return {};
    });

    this.server.setRequestHandler(UxcCanReapRequestSchema, async () => {
      return this.resolveCanReapResult(options.bridgeControl.getState());
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
    this.unsubscribeResourceUpdates();
    this.unsubscribeToolsetChanges();
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

  private resolveCanReapResult(state: LocalBridgeState): McpCanReapResult {
    const ownsExternalResource = state.ownership !== "none";
    const waitingForHuman =
      state.controlMode === "bootstrap" ||
      state.authState === "auth_required" ||
      state.authState === "challenge_required" ||
      state.sessionState === "auth_required" ||
      state.sessionState === "challenge_required" ||
      state.sessionState === "bootstrap_active";

    if (waitingForHuman) {
      return {
        can_reap: false,
        reason: "waiting_for_human",
        retry_after_secs: CAN_REAP_RETRY_AFTER_SECS,
        state: {
          interactive: true,
          owns_external_resource: ownsExternalResource,
          waiting_for_human: true,
        },
      };
    }

    if (state.presentationMode === "headed") {
      return {
        can_reap: false,
        reason: "interactive_headed_session",
        retry_after_secs: CAN_REAP_RETRY_AFTER_SECS,
        state: {
          interactive: true,
          owns_external_resource: ownsExternalResource,
          waiting_for_human: false,
        },
      };
    }

    return {
      can_reap: true,
      reason: state.mode === "control-only" ? "idle_control_plane" : "idle_headless_session",
      state: {
        interactive: false,
        owns_external_resource: ownsExternalResource,
        waiting_for_human: false,
      },
    };
  }

  private toMcpResourceDefinition(resource: WebMcpResourceDefinition): Record<string, unknown> {
    return {
      uri: resource.uri,
      ...(resource.name !== undefined ? { name: resource.name } : {}),
      ...(resource.description !== undefined ? { description: resource.description } : {}),
      ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
    };
  }

  private toMcpResourceContents(
    uri: string,
    value: JsonValue,
    mimeType: string | undefined,
  ): Record<string, unknown> {
    return {
      uri,
      mimeType: mimeType ?? "application/json",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    };
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
    const tools = [...this.bridgeTools(), ...(await gateway.listTools())];
    const signature = this.computeToolsSignature(tools);
    this.lastToolsSignature = signature;
    return signature;
  }

  private async notifyIfToolsChanged(gateway: LocalMcpGateway, previousSignature: string): Promise<void> {
    const tools = await gateway.listTools();
    const nextTools = [...this.bridgeTools(), ...tools];
    const nextSignature = this.computeToolsSignature(nextTools);
    this.lastToolsSignature = nextSignature;
    if (nextSignature === previousSignature) {
      return;
    }
    await this.server.sendToolListChanged().catch(() => {
      // Ignore when client does not advertise listChanged support or session is not notification-ready.
    });
  }

  private async notifyCurrentToolListChanged(gateway: LocalMcpGateway): Promise<void> {
    this.toolsetNotification = this.toolsetNotification
      .catch(() => {
        // Keep the chain alive after previous notification failures.
      })
      .then(async () => {
        if (this.lastToolsSignature === undefined) {
          return;
        }
        await this.notifyIfToolsChanged(gateway, this.lastToolsSignature);
      });
    await this.toolsetNotification;
  }

  private async resolveResourceMimeType(
    gateway: LocalMcpGateway,
    uri: string,
  ): Promise<string | undefined> {
    if (this.resourceMimeTypes.has(uri)) {
      return this.resourceMimeTypes.get(uri);
    }
    const resources = await this.listResources(gateway);
    return resources.find((resource) => resource.uri === uri)?.mimeType;
  }

  private async listResources(
    gateway: LocalMcpGateway,
  ): Promise<ReadonlyArray<WebMcpResourceDefinition>> {
    const resources = await gateway.listResources();
    for (const resource of resources) {
      this.resourceMimeTypes.set(resource.uri, resource.mimeType);
    }
    return resources;
  }

  private async notifyResourceUpdated(uri: string): Promise<void> {
    if (!this.subscribedResourceUris.has(uri)) {
      return;
    }
    await this.server.sendResourceUpdated({ uri }).catch(() => {
      // Ignore when client has not completed initialization or is not notification-ready.
    });
  }

  private bridgeTools(): ReadonlyArray<WebMcpToolDefinition> {
    return [
      {
        name: "bridge.window.open",
        description: "Open or focus the browser window for the current headed local-mcp session.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "bridge.session.status",
        description: "Return local-mcp bridge session state for the current site session.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
          readOnlyHint: true,
        },
      },
      {
        name: "bridge.session.bootstrap",
        description: "Launch a normal browser for manual sign-in on the managed site profile.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "bridge.session.attach",
        description: "Restart the current local-mcp bridge session in attach mode against an existing Chromium browser.",
        inputSchema: {
          type: "object",
          properties: {
            browserUrl: {
              type: "string",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "bridge.session.mode.get",
        description: "Return the current runtime presentation mode for the local-mcp bridge session.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
          readOnlyHint: true,
        },
      },
      {
        name: "bridge.session.mode.set",
        description: "Switch the managed local-mcp bridge runtime between headed and headless presentation modes.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["headed", "headless"],
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      {
        name: "bridge.session.stop",
        description: "Stop the current local-mcp bridge session.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "bridge.session.reset_profile",
        description: "Back up and reset the managed browser profile for the current local-mcp bridge session.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "bridge.open",
        description: "Legacy alias for bridge.window.open.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "bridge.close",
        description: "Legacy alias for bridge.session.stop.",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ];
  }

  private async listAllTools(options: LocalMcpStdioServerOptions): Promise<ReadonlyArray<WebMcpToolDefinition>> {
    const pageTools = await options.gateway.listTools();
    return [...this.bridgeTools(), ...pageTools];
  }

  private isBridgeToolName(name: string): boolean {
    return (
      name === "bridge.window.open" ||
      name === "bridge.session.status" ||
      name === "bridge.session.bootstrap" ||
      name === "bridge.session.attach" ||
      name === "bridge.session.mode.get" ||
      name === "bridge.session.mode.set" ||
      name === "bridge.session.stop" ||
      name === "bridge.session.reset_profile" ||
      name === "bridge.open" ||
      name === "bridge.close"
    );
  }

  private parseOptionalBrowserUrl(input: Record<string, unknown>): string | undefined {
    const browserUrl = input.browserUrl;
    if (browserUrl === undefined) {
      return undefined;
    }
    if (typeof browserUrl !== "string" || !browserUrl.trim()) {
      throw new Error("INVALID_ARGUMENT: browserUrl must be a non-empty string when provided");
    }
    return browserUrl.trim();
  }

  private parsePresentationModeSetOptions(input: Record<string, unknown>): LocalBridgePresentationModeSetOptions {
    const mode = input.mode;
    if (mode === "headed" || mode === "headless") {
      return {
        presentationMode: mode,
      };
    }
    throw new Error("INVALID_ARGUMENT: mode must be headed or headless");
  }

  private toBridgeErrorResult(error: unknown): JsonValue {
    const message = error instanceof Error ? error.message : String(error);
    const codeMatch = /^([A-Z][A-Z0-9_]*):/.exec(message);
    const code = codeMatch?.[1] ?? "BRIDGE_CONTROL_FAILED";
    return {
      ok: false,
      error: {
        code,
        message,
      },
    };
  }

  private async callBridgeTool(
    options: LocalMcpStdioServerOptions,
    name: string,
    input: Record<string, unknown>,
  ): Promise<JsonValue> {
    const state = options.bridgeControl.getState();
    if (name === "bridge.window.open" || name === "bridge.open") {
      try {
        const windowState = await options.bridgeControl.openWindow();
        return {
          ok: true,
          site: state.site,
          targetUrl: state.targetUrl,
          controlMode: state.controlMode,
          ...(state.browserUrl !== undefined ? { browserUrl: state.browserUrl } : {}),
          mode: state.mode,
          presentationMode: state.presentationMode,
          preferredPresentationMode: state.preferredPresentationMode,
          windowState,
        };
      } catch (error) {
        return this.toBridgeErrorResult(error);
      }
    }
    if (name === "bridge.session.status") {
      return {
        ok: true,
        session: {
          site: state.site,
          targetUrl: state.targetUrl,
          controlMode: state.controlMode,
          ...(state.browserUrl !== undefined ? { browserUrl: state.browserUrl } : {}),
          mode: state.mode,
          presentationMode: state.presentationMode,
          preferredPresentationMode: state.preferredPresentationMode,
          authPolicyMode: state.authPolicyMode,
          authState: state.authState,
          sessionState: state.sessionState,
          ownership: state.ownership,
          ...(state.profilePath !== undefined ? { profilePath: state.profilePath } : {}),
          ...(state.browserPid !== undefined ? { browserPid: state.browserPid } : {}),
          ...(state.lastBackupPath !== undefined ? { lastBackupPath: state.lastBackupPath } : {}),
        },
      };
    }
    if (name === "bridge.session.bootstrap") {
      try {
        const nextState = await options.bridgeControl.bootstrapSession();
        return {
          ok: true,
          session: nextState,
          bootstrapped: true,
        };
      } catch (error) {
        return this.toBridgeErrorResult(error);
      }
    }
    if (name === "bridge.session.attach") {
      try {
        const nextState = await options.bridgeControl.attachSession(this.parseOptionalBrowserUrl(input));
        return {
          ok: true,
          session: nextState,
          restarted: true,
        };
      } catch (error) {
        return this.toBridgeErrorResult(error);
      }
    }
    if (name === "bridge.session.mode.get") {
      return {
        ok: true,
        presentationMode: options.bridgeControl.getPresentationMode(),
      };
    }
    if (name === "bridge.session.mode.set") {
      try {
        const nextState = await options.bridgeControl.setPresentationMode(
          this.parsePresentationModeSetOptions(input),
        );
        return {
          ok: true,
          updated: true,
          presentationMode: nextState.presentationMode,
          session: nextState,
        };
      } catch (error) {
        return this.toBridgeErrorResult(error);
      }
    }
    if (name === "bridge.session.reset_profile") {
      try {
        const nextState = await options.bridgeControl.resetProfile();
        return {
          ok: true,
          session: nextState,
          reset: true,
        };
      } catch (error) {
        return this.toBridgeErrorResult(error);
      }
    }
    if (name !== "bridge.session.stop" && name !== "bridge.close") {
      return {
        ok: false,
        error: {
          code: "BRIDGE_TOOL_NOT_SUPPORTED",
          message: `unsupported bridge tool: ${name}`,
        },
      };
    }

    setTimeout(() => {
      void options.bridgeControl.closeBridge().catch(options.onError);
    }, LocalMcpStdioServerImpl.BRIDGE_CLOSE_DELAY_MS);
    return {
      ok: true,
      site: state.site,
      targetUrl: state.targetUrl,
      controlMode: state.controlMode,
      ...(state.browserUrl !== undefined ? { browserUrl: state.browserUrl } : {}),
      mode: state.mode,
      presentationMode: state.presentationMode,
      preferredPresentationMode: state.preferredPresentationMode,
      authPolicyMode: state.authPolicyMode,
      authState: state.authState,
      sessionState: state.sessionState,
      ownership: state.ownership,
      ...(state.profilePath !== undefined ? { profilePath: state.profilePath } : {}),
      ...(state.browserPid !== undefined ? { browserPid: state.browserPid } : {}),
      ...(state.lastBackupPath !== undefined ? { lastBackupPath: state.lastBackupPath } : {}),
      closing: true,
    };
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
