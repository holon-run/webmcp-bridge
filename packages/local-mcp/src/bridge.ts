/**
 * This module composes runtime startup with the stdio MCP server into one lifecycle handle.
 * It depends on runtime and server modules so CLI and tests can start a complete local-mcp bridge in one call.
 */

import type { Readable, Writable } from "node:stream";
import {
  createLocalMcpStdioServer,
  type LocalMcpStdioServer,
  type LocalMcpStdioServerOptions,
} from "./server.js";
import {
  startLocalMcpRuntime,
  type LocalMcpRuntime,
  type LocalMcpRuntimeOptions,
} from "./runtime.js";

export type StartLocalMcpBridgeOptions = LocalMcpRuntimeOptions & {
  serviceVersion: string;
  autoLoginFallback?: boolean;
  input?: Readable;
  output?: Writable;
  onError?: (error: unknown) => void;
};

export type LocalMcpBridgeHandle = {
  site: LocalMcpRuntime["site"];
  targetUrl: string;
  mode: "native" | "shim";
  headless: boolean;
  close: () => Promise<void>;
};

type XAuthState = "authenticated" | "auth_required" | "challenge_required";

function readXAuthState(value: unknown): XAuthState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const state = (value as { state?: unknown }).state;
  if (state === "authenticated" || state === "auth_required" || state === "challenge_required") {
    return state;
  }
  return undefined;
}

async function resolveRuntime(options: StartLocalMcpBridgeOptions): Promise<LocalMcpRuntime> {
  const primary = await startLocalMcpRuntime(options);
  const autoLoginFallback = options.autoLoginFallback ?? true;
  const requestedHeadless = options.headless ?? false;
  if (!autoLoginFallback || options.site !== "x" || !requestedHeadless) {
    return primary;
  }

  try {
    const authResult = await primary.gateway.callTool("auth.get", {});
    const state = readXAuthState(authResult);
    if (state !== "auth_required" && state !== "challenge_required") {
      return primary;
    }
  } catch {
    // Ignore auth probing failures and keep current runtime.
    return primary;
  }

  await primary.close();
  return await startLocalMcpRuntime({
    ...options,
    headless: false,
  });
}

export async function startLocalMcpBridge(options: StartLocalMcpBridgeOptions): Promise<LocalMcpBridgeHandle> {
  const runtime = await resolveRuntime(options);

  let server: LocalMcpStdioServer | undefined;
  try {
    const serverOptions: LocalMcpStdioServerOptions = {
      gateway: runtime.gateway,
      serviceVersion: options.serviceVersion,
    };
    if (options.input !== undefined) {
      serverOptions.input = options.input;
    }
    if (options.output !== undefined) {
      serverOptions.output = options.output;
    }
    if (options.onError !== undefined) {
      serverOptions.onError = options.onError;
    }

    server = createLocalMcpStdioServer(serverOptions);
    await server.start();
  } catch (error) {
    await runtime.close();
    throw error;
  }

  let closed = false;
  return {
    site: runtime.site,
    targetUrl: runtime.targetUrl,
    mode: runtime.mode,
    headless: runtime.headless,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await server?.close();
      await runtime.close();
    },
  };
}
