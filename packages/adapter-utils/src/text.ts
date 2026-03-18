/**
 * This module provides low-level text normalization helpers for adapter parsing paths.
 * It is dependency-free so site adapters can reuse it without importing site-specific logic.
 */

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function dedupeStrings(values: readonly string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (output[output.length - 1] !== value) {
      output.push(value);
    }
  }
  return output;
}

export function joinTextParts(values: readonly string[]): string {
  return values.map((value) => normalizeText(value)).filter((value) => value.length > 0).join("");
}
