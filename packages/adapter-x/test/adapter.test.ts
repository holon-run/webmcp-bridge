/**
 * This module tests the adapter-x tool dispatch and auth validation behavior.
 * It depends on adapter factory and page-like mocks for deterministic unit assertions.
 */

import { describe, expect, it, vi } from "vitest";
import { createXAdapter } from "../src/index.js";

function makePage(authenticated: boolean) {
  return {
    evaluate: vi.fn(async (fn: (...args: unknown[]) => unknown) => {
      const fnText = fn.toString();
      if (fnText.includes("hasComposer") || fnText.includes("hasNav")) {
        return authenticated;
      }
      if (fnText.includes("nodes.slice")) {
        return [{ id: "timeline-1", text: "hello" }];
      }
      return { ok: true };
    }),
  };
}

describe("createXAdapter", () => {
  it("returns auth required when not logged in", async () => {
    const adapter = createXAdapter();
    const page = makePage(false);
    const result = await adapter.callTool({ name: "x.timeline.read", input: {} }, { page: page as never });
    expect(result).toEqual({ error: { code: "AUTH_REQUIRED", message: "login required" } });
  });

  it("reads timeline when logged in", async () => {
    const adapter = createXAdapter();
    const page = makePage(true);
    const result = await adapter.callTool({ name: "x.timeline.read", input: { limit: 1 } }, { page: page as never });
    expect(result).toEqual({ items: [{ id: "timeline-1", text: "hello" }] });
  });
});
