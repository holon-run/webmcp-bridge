/**
 * This module provides reusable assertions for WebMCP tool contract tests.
 * It depends on core JsonValue types so adapters can share one result-shape validator.
 */

import type { JsonValue } from "@webmcp-bridge/core";

export function assertToolResultShape(value: JsonValue): asserts value is JsonValue {
  if (value === undefined) {
    throw new Error("tool result must be JSON-serializable and not undefined");
  }
}

export function normalizeErrorResult(code: string, message: string): JsonValue {
  return {
    error: {
      code,
      message,
    },
  };
}
