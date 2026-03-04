/**
 * This module provides a minimal third-party adapter template for local-mcp dynamic loading.
 * It depends on the playwright adapter contract and can be launched with --adapter-module.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type {
  AdapterManifest,
  SiteAdapter,
  WebMcpToolDefinition,
} from "@webmcp-bridge/playwright";

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "auth.get",
    description: "Report whether this template adapter is ready",
    inputSchema: {
      type: "object",
      description: "No parameters.",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "echo.execute",
    description: "Echo an input value for connectivity checks",
    inputSchema: {
      type: "object",
      description: "Echo one JSON value.",
      properties: {
        value: {
          description: "Any JSON value.",
        },
      },
      required: ["value"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
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

export const manifest: AdapterManifest = {
  id: "example.com",
  displayName: "Adapter Template",
  version: "0.1.0",
  bridgeApiVersion: "1.0.0",
  defaultUrl: "https://example.com",
  hostPatterns: ["example.com", "www.example.com"],
  authProbeTool: "auth.get",
};

export function createAdapter(): SiteAdapter {
  return {
    name: "adapter-template",
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }) => {
      if (name === "auth.get") {
        return {
          state: "authenticated",
          source: "adapter-template",
        };
      }

      if (name === "echo.execute") {
        const args = toRecord(input);
        if (!("value" in args)) {
          return errorResult("VALIDATION_ERROR", "value is required");
        }
        return {
          value: (args.value as JsonValue) ?? null,
          source: "adapter-template",
        };
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
  };
}
