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
    name: "auth.get",
    description: "Get current fixture auth state",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "auth.set",
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
    name: "echo.execute",
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
    name: "math.add",
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
    name: "fail.execute",
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
  let authState: FixtureAuthState = options?.initialAuthState ?? "authenticated";

  return {
    name: "adapter-fixture",
    start: async () => {},
    stop: async () => {},
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }) => {
      const args = toRecord(input);

      if (name === "auth.get") {
        return { state: authState };
      }

      if (name === "auth.set") {
        const state = args.state;
        if (state !== "authenticated" && state !== "auth_required") {
          return errorResult("VALIDATION_ERROR", "state must be authenticated or auth_required");
        }
        authState = state;
        return { ok: true, state: authState };
      }

      if (name === "echo.execute") {
        if (!("value" in args)) {
          return errorResult("VALIDATION_ERROR", "value is required");
        }
        return { value: (args.value as JsonValue) ?? null };
      }

      if (name === "math.add") {
        const a = readNumber(args, "a");
        const b = readNumber(args, "b");
        if (a === undefined || b === undefined) {
          return errorResult("VALIDATION_ERROR", "a and b must be finite numbers");
        }
        return { value: a + b };
      }

      if (name === "fail.execute") {
        const code = typeof args.code === "string" && args.code.trim() ? args.code : "FIXTURE_ERROR";
        const message =
          typeof args.message === "string" && args.message.trim() ? args.message : "fixture requested failure";
        return errorResult(code, message);
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
  };
}
