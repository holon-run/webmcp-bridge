/**
 * This module installs the modelContext shim on a target environment.
 * It depends on runtime creation and exposes a stable install handle for callers.
 */

import { createBridgeRuntime } from "./runtime.js";
import type {
  BridgeHandle,
  BridgeInstallTarget,
  BridgeToolDefinition,
  BridgeTransport,
  JsonValue,
  ModelContextLike,
} from "./types.js";

export type InstallBridgeOptions = {
  preferNative?: boolean;
  transport?: BridgeTransport;
};

export function isNativeModelContext(target: BridgeInstallTarget): boolean {
  const modelContext = target.navigator.modelContext;
  if (!modelContext) {
    return false;
  }
  return (
    typeof modelContext.registerTool === "function" &&
    typeof modelContext.unregisterTool === "function"
  );
}

export function installModelContextBridge(
  target: BridgeInstallTarget,
  options?: InstallBridgeOptions,
): BridgeHandle {
  const preferNative = options?.preferNative ?? true;
  const native = target.navigator.modelContext;

  if (preferNative && isNativeModelContext(target) && native) {
    return {
      mode: "native",
      listTools: () => [],
      invokeTool: async (name: string, input: JsonValue) => {
        const nativeAny = native as unknown as { callTool?: (toolName: string, payload: JsonValue) => Promise<JsonValue> };
        if (typeof nativeAny.callTool !== "function") {
          throw new Error("native modelContext callTool is not available");
        }
        return await nativeAny.callTool(name, input);
      },
      uninstall: () => {
        // no-op for native mode
      },
    };
  }

  const runtime = createBridgeRuntime(options?.transport);
  const previous = target.navigator.modelContext;

  Object.defineProperty(target.navigator, "modelContext", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: runtime.modelContext,
  });

  return {
    mode: "shim",
    listTools: () => runtime.listTools(),
    invokeTool: (name, input) => runtime.invokeTool(name, input),
    uninstall: () => {
      runtime.clear();
      if (previous) {
        Object.defineProperty(target.navigator, "modelContext", {
          configurable: true,
          enumerable: false,
          writable: false,
          value: previous as ModelContextLike,
        });
        return;
      }
      delete target.navigator.modelContext;
    },
  };
}

export function defineLocalTool(
  name: string,
  execute: BridgeToolDefinition["execute"],
  description?: string,
): BridgeToolDefinition {
  const tool: BridgeToolDefinition = {
    name,
    execute,
  };
  if (description !== undefined) {
    tool.description = description;
  }
  return tool;
}
