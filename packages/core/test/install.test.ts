/**
 * This module tests bridge install behavior for shim and native detection paths.
 * It depends on core install helpers to validate expected runtime semantics.
 */

import { describe, expect, it } from "vitest";
import { defineLocalTool, installModelContextBridge, isNativeModelContext } from "../src/index.js";
import type { BridgeInstallTarget } from "../src/index.js";

describe("installModelContextBridge", () => {
  it("installs shim and invokes registered tools", async () => {
    const target: BridgeInstallTarget = { navigator: {} };
    const handle = installModelContextBridge(target);
    expect(handle.mode).toBe("shim");

    await target.navigator.modelContext?.registerTool(
      defineLocalTool("x.health", async () => ({ ok: true })),
    );

    const result = await handle.invokeTool("x.health", {});
    expect(result).toEqual({ ok: true });

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
        },
      },
    };

    expect(isNativeModelContext(target)).toBe(true);
    const handle = installModelContextBridge(target);
    expect(handle.mode).toBe("native");
  });
});
