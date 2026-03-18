/**
 * This module tests the package-level low-level utilities exported by adapter-utils.
 * It keeps coverage focused on pure helpers that are expected to stay reusable across adapters.
 */

import { describe, expect, it } from "vitest";
import { collectTextByTag, dedupeStrings, joinTextParts, normalizeText, parseNdjsonLines } from "../src/index.js";

describe("adapter-utils", () => {
  it("normalizes and deduplicates text", () => {
    expect(normalizeText("  hello \n world  ")).toBe("hello world");
    expect(dedupeStrings(["a", "a", "b", "b", "a"])).toEqual(["a", "b", "a"]);
    expect(joinTextParts(["  hello", " ", "world  "])).toBe("helloworld");
  });

  it("parses ndjson and collects tagged text", () => {
    const entries = parseNdjsonLines<Array<{ message?: string; messageTag?: string }> extends never ? never : { message?: string; messageTag?: string }>(
      `{"message":"foo","messageTag":"final"}\n{"message":"bar","messageTag":"summary"}\n{"message":"baz","messageTag":"final"}\nnot-json\n`,
    );

    expect(entries).toEqual([
      { message: "foo", messageTag: "final" },
      { message: "bar", messageTag: "summary" },
      { message: "baz", messageTag: "final" },
    ]);
    expect(collectTextByTag(entries, "final")).toEqual(["foo", "baz"]);
  });
});
