/**
 * This module tests fixture adapter behavior for deterministic integration-tool assertions.
 * It depends on the fixture adapter factory and validates stable response and error shapes.
 */

import { describe, expect, it } from "vitest";
import { createFixtureAdapter } from "../src/index.js";

describe("createFixtureAdapter", () => {
  it("returns deterministic auth state", async () => {
    const adapter = createFixtureAdapter();

    await adapter.start?.({ page: {} as never });
    const state = await adapter.callTool({ name: "auth.get", input: {} }, { page: {} as never });
    expect(state).toEqual({ state: "authenticated" });
  });

  it("supports auth state toggling", async () => {
    const adapter = createFixtureAdapter({ initialAuthState: "auth_required" });
    await adapter.start?.({ page: {} as never });

    await expect(
      adapter.callTool({ name: "auth.get", input: {} }, { page: {} as never }),
    ).resolves.toEqual({ state: "auth_required" });

    await expect(
      adapter.callTool(
        {
          name: "auth.set",
          input: { state: "authenticated" },
        },
        { page: {} as never },
      ),
    ).resolves.toEqual({ ok: true, state: "authenticated" });

    await expect(
      adapter.callTool({ name: "auth.get", input: {} }, { page: {} as never }),
    ).resolves.toEqual({ state: "authenticated" });
  });

  it("validates numeric input for math.add", async () => {
    const adapter = createFixtureAdapter();
    await adapter.start?.({ page: {} as never });

    await expect(
      adapter.callTool({ name: "math.add", input: { a: 2, b: 3 } }, { page: {} as never }),
    ).resolves.toEqual({ value: 5 });

    await expect(
      adapter.callTool({ name: "math.add", input: { a: 2, b: "3" } }, { page: {} as never }),
    ).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "a and b must be finite numbers",
      },
    });
  });
});
