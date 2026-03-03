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
  input?: Readable;
  output?: Writable;
  onError?: (error: unknown) => void;
};

export type LocalMcpBridgeHandle = {
  site: LocalMcpRuntime["site"];
  targetUrl: string;
  mode: "native" | "shim";
  close: () => Promise<void>;
};

export async function startLocalMcpBridge(options: StartLocalMcpBridgeOptions): Promise<LocalMcpBridgeHandle> {
  const runtime = await startLocalMcpRuntime(options);

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
