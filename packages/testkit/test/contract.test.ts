/**
 * This module tests contract helper behavior in testkit.
 * It depends on exported assertions to guarantee deterministic validation semantics.
 */

import { describe, expect, it } from "vitest";
import { assertToolResultShape, normalizeErrorResult } from "../src/index.js";

describe("testkit contract", () => {
  it("accepts json values", () => {
    expect(() => assertToolResultShape({ ok: true })).not.toThrow();
  });

  it("normalizes error payload", () => {
    expect(normalizeErrorResult("AUTH_REQUIRED", "login required")).toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "login required",
      },
    });
  });
});
