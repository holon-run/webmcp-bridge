/**
 * This module tests bridge install behavior for shim and native detection paths.
 * It depends on core install helpers to validate expected runtime semantics.
 */

import { describe, expect, it } from "vitest";
import {
  defineLocalResource,
  defineLocalTool,
  installModelContextBridge,
  isNativeModelContext,
} from "../src/index.js";
import type { BridgeInstallTarget } from "../src/index.js";

describe("installModelContextBridge", () => {
  it("installs shim and invokes registered tools", async () => {
    const target: BridgeInstallTarget = { navigator: {} };
    const handle = installModelContextBridge(target);
    expect(handle.mode).toBe("shim");

    await target.navigator.modelContext?.registerTool(
      defineLocalTool("ping", async () => ({ ok: true })),
    );

    const result = await handle.invokeTool("ping", {});
    expect(result).toEqual({ ok: true });

    await target.navigator.modelContext?.registerResource(
      defineLocalResource("board://local/scene", async () => ({ title: "Board" }), {
        name: "Board Scene",
        mimeType: "application/json",
      }),
    );

    expect(handle.listResources()).toEqual([
      {
        uri: "board://local/scene",
        name: "Board Scene",
        mimeType: "application/json",
      },
    ]);
    await expect(handle.readResource("board://local/scene")).resolves.toEqual({ title: "Board" });

    handle.uninstall();
    expect(target.navigator.modelContext).toBeUndefined();
  });

  it("detects native context", () => {
    const target = {
      navigator: {
        modelContext: {
          provideContext: async () => {},
          clearContext: async () => {},
          registerTool: async () => {},
          unregisterTool: async () => {},
          registerResource: async () => {},
          unregisterResource: async () => {},
          listResources: async () => [],
          readResource: async () => ({ ok: true }),
          notifyResourceUpdated: async () => {},
        },
      },
    };

    expect(isNativeModelContext(target)).toBe(true);
    const handle = installModelContextBridge(target);
    expect(handle.mode).toBe("native");
  });
});
