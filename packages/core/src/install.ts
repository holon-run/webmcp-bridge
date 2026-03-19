/**
 * This module installs the modelContext shim on a target environment.
 * It depends on runtime creation and exposes a stable install handle for callers.
 */

import { createBridgeRuntime } from "./runtime.js";
import type {
  BridgeHandle,
  BridgeInstallTarget,
  BridgeResourceDefinition,
  BridgeResourceDescriptor,
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
    typeof modelContext.unregisterTool === "function" &&
    typeof modelContext.registerResource === "function" &&
    typeof modelContext.unregisterResource === "function"
  );
}

export function installModelContextBridge(
  target: BridgeInstallTarget,
  options?: InstallBridgeOptions,
): BridgeHandle {
  const preferNative = options?.preferNative ?? true;
  const native = target.navigator.modelContext;

  if (preferNative && isNativeModelContext(target) && native) {
    const nativeAny = native as unknown as {
      callTool?: (toolName: string, payload: JsonValue) => Promise<JsonValue>;
      listResources?: () => Promise<unknown> | unknown;
      readResource?: (resourceUri: string) => Promise<JsonValue>;
    };
    let nativeResources: BridgeResourceDescriptor[] = [];
    const refreshNativeResources = (): void => {
      if (typeof nativeAny.listResources !== "function") {
        nativeResources = [];
        return;
      }
      void Promise.resolve(nativeAny.listResources())
        .then((resources) => {
          nativeResources = toNativeResourceDescriptors(resources);
        })
        .catch(() => {
          nativeResources = [];
        });
    };
    refreshNativeResources();
    return {
      mode: "native",
      listTools: () => [],
      invokeTool: async (name: string, input: JsonValue) => {
        if (typeof nativeAny.callTool !== "function") {
          throw new Error("native modelContext callTool is not available");
        }
        return await nativeAny.callTool(name, input);
      },
      listResources: () => [...nativeResources],
      readResource: async (uri: string) => {
        if (typeof nativeAny.readResource !== "function") {
          throw new Error("native modelContext readResource is not available");
        }
        refreshNativeResources();
        return await nativeAny.readResource(uri);
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
    listResources: () => runtime.listResources(),
    readResource: (uri) => runtime.readResource(uri),
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

function toNativeResourceDescriptors(value: unknown): BridgeResourceDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): BridgeResourceDescriptor[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const candidate = entry as {
      uri?: unknown;
      name?: unknown;
      description?: unknown;
      mimeType?: unknown;
    };
    if (typeof candidate.uri !== "string" || !candidate.uri.trim()) {
      return [];
    }
    return [
      {
        uri: candidate.uri,
        name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : candidate.uri,
        ...(typeof candidate.description === "string" && candidate.description.trim()
          ? { description: candidate.description }
          : {}),
        ...(typeof candidate.mimeType === "string" && candidate.mimeType.trim()
          ? { mimeType: candidate.mimeType }
          : {}),
      },
    ];
  });
}

export function defineLocalResource(
  uri: string,
  read: BridgeResourceDefinition["read"],
  options?: Omit<BridgeResourceDefinition, "uri" | "read">,
): BridgeResourceDefinition {
  const resource: BridgeResourceDefinition = {
    uri,
    name: options?.name ?? uri,
    read,
  };
  if (options?.description !== undefined) {
    resource.description = options.description;
  }
  if (options?.mimeType !== undefined) {
    resource.mimeType = options.mimeType;
  }
  return resource;
}
