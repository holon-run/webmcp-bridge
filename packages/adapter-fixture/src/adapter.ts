/**
 * This module implements a deterministic fixture site adapter for integration testing.
 * It depends on Playwright adapter contracts and avoids site DOM coupling by using in-memory behavior.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { SiteAdapter, WebMcpToolDefinition } from "@webmcp-bridge/playwright";

type FixtureAuthState = "authenticated" | "auth_required";

export type CreateFixtureAdapterOptions = {
  initialAuthState?: FixtureAuthState;
};

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "fixture.health",
    description: "Get fixture adapter health and call counters",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fixture.auth_state",
    description: "Get current fixture auth state",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fixture.set_auth_state",
    description: "Set fixture auth state",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["authenticated", "auth_required"],
        },
      },
      required: ["state"],
      additionalProperties: false,
    },
  },
  {
    name: "fixture.echo",
    description: "Return the input payload for deterministic roundtrip assertions",
    inputSchema: {
      type: "object",
      properties: {
        value: {},
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "fixture.math.add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "fixture.fail",
    description: "Return a deterministic error payload",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function toRecord(value: JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorResult(code: string, message: string): JsonValue {
  return {
    error: {
      code,
      message,
    },
  };
}

function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createFixtureAdapter(options?: CreateFixtureAdapterOptions): SiteAdapter {
  let started = false;
  let callCount = 0;
  let authState: FixtureAuthState = options?.initialAuthState ?? "authenticated";

  return {
    name: "adapter-fixture",
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
    },
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }) => {
      callCount += 1;
      const args = toRecord(input);

      if (name === "fixture.health") {
        return {
          ok: true,
          adapter: "fixture",
          started,
          callCount,
        };
      }

      if (name === "fixture.auth_state") {
        return { state: authState };
      }

      if (name === "fixture.set_auth_state") {
        const state = args.state;
        if (state !== "authenticated" && state !== "auth_required") {
          return errorResult("VALIDATION_ERROR", "state must be authenticated or auth_required");
        }
        authState = state;
        return { ok: true, state: authState };
      }

      if (name === "fixture.echo") {
        if (!("value" in args)) {
          return errorResult("VALIDATION_ERROR", "value is required");
        }
        return { value: (args.value as JsonValue) ?? null };
      }

      if (name === "fixture.math.add") {
        const a = readNumber(args, "a");
        const b = readNumber(args, "b");
        if (a === undefined || b === undefined) {
          return errorResult("VALIDATION_ERROR", "a and b must be finite numbers");
        }
        return { value: a + b };
      }

      if (name === "fixture.fail") {
        const code = typeof args.code === "string" && args.code.trim() ? args.code : "FIXTURE_ERROR";
        const message =
          typeof args.message === "string" && args.message.trim() ? args.message : "fixture requested failure";
        return errorResult(code, message);
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
  };
}
