/**
 * This module provides stream-oriented parsing helpers for adapter network responses.
 * It only handles generic line-delimited JSON and text assembly; site-specific schemas stay in adapters.
 */

export function parseNdjsonLines<T>(text: string): T[] {
  const entries: T[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return entries;
}

export function collectTextByTag<T extends { message?: string; messageTag?: string }>(
  entries: readonly T[],
  tag: string,
): string[] {
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.messageTag === tag && typeof entry.message === "string") {
      output.push(entry.message);
    }
  }
  return output;
}
