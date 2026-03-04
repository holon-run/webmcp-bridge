/**
 * This module tests adapter-x auth gating, compose confirmation, and schema-level behavior.
 * It depends on adapter factory APIs and page-like mocks to keep unit assertions deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { createXAdapter } from "../src/index.js";

type Behavior = {
  authState: "authenticated" | "auth_required" | "challenge_required";
  authSignals: string[];
  timelineItems: Array<{ id: string; text: string; url?: string }>;
  composeResult: { ok: boolean; dryRun?: boolean; reason?: string; submitVisible?: boolean };
  confirmCompose: boolean;
  statusUrl?: string;
};

function createMockPage(partial: Partial<Behavior> = {}) {
  const behavior: Behavior = {
    authState: "authenticated",
    authSignals: ["authenticated_ui"],
    timelineItems: [{ id: "timeline-1", text: "hello", url: "https://x.com/a/status/1" }],
    composeResult: { ok: true },
    confirmCompose: true,
    statusUrl: "https://x.com/example/status/123",
    ...partial,
  };

  const page = {
    addInitScript: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
        return undefined;
      }

      const command = arg as Record<string, unknown>;
      if (command.op === "detect_auth") {
        return {
          state: behavior.authState,
          signals: behavior.authSignals,
        };
      }

      if (typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (typeof command.content === "string" && typeof command.dryRunMode === "boolean") {
        return behavior.composeResult;
      }

      if (typeof command.needle === "string") {
        return behavior.statusUrl;
      }

      return undefined;
    }),
    waitForSelector: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {
      if (!behavior.confirmCompose) {
        throw new Error("timeout");
      }
      return true;
    }),
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    context: vi.fn(() => ({
      newPage: vi.fn(async () => ({
        evaluate: page.evaluate,
        addInitScript: vi.fn(async () => {}),
        goto: vi.fn(async () => {}),
        waitForTimeout: vi.fn(async () => {}),
        waitForFunction: vi.fn(async () => true),
        reload: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      })),
    })),
  };

  return {
    page,
    behavior,
  };
}

describe("createXAdapter", () => {
  it("publishes tool schemas", async () => {
    const adapter = createXAdapter();
    const tools = await adapter.listTools({ page: {} as never });
    const compose = tools.find((tool) => tool.name === "tweet.create");

    expect(compose?.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["text"],
      }),
    );
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["timeline.list", "tweet.get", "favorites.list", "user.get"]),
    );
  });

  it("returns auth required for timeline reads when logged out", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      authState: "auth_required",
      authSignals: ["login_ui"],
    });

    const result = await adapter.callTool({ name: "timeline.list", input: {} }, { page: page as never });

    expect(result).toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "login required",
        details: {
          state: "auth_required",
          signals: ["login_ui"],
        },
      },
    });
  });

  it("returns challenge required for compose when x challenge blocks actions", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      authState: "challenge_required",
      authSignals: ["challenge_ui"],
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "CHALLENGE_REQUIRED",
        message: "x.com challenge is blocking actions",
        details: {
          state: "challenge_required",
          signals: ["challenge_ui"],
        },
      },
    });
  });

  it("supports dry-run compose without waiting confirmation", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      composeResult: { ok: true, dryRun: true, submitVisible: true },
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello", dryRun: true } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      submitVisible: true,
    });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("fails closed when compose submit cannot be confirmed", async () => {
    const adapter = createXAdapter({ composeConfirmTimeoutMs: 100 });
    const { page } = createMockPage({
      composeResult: { ok: true },
      confirmCompose: false,
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "ACTION_UNCONFIRMED",
        message: "post submit was not confirmed in timeline",
      },
    });
  });

  it("returns confirmed compose result when timeline confirms post", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      composeResult: { ok: true },
      confirmCompose: true,
      statusUrl: "https://x.com/example/status/999",
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      confirmed: true,
      statusUrl: "https://x.com/example/status/999",
    });
  });

  it("returns validation error for tweet.get without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "tweet.get", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });
});
