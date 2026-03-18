/**
 * This module provides low-level request-template and fallback-result helpers for adapters.
 * It stays Playwright-agnostic so site adapters can reuse it without importing browser runtime details.
 */

export type RequestTemplate = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

export type NetworkExecutionResult<T> = {
  source: "network";
  data: T;
  reason?: string;
};

export type DomFallbackResult<T> = {
  source: "dom";
  data: T;
  reason: string;
};

export type AdapterExecutionResult<T> = NetworkExecutionResult<T> | DomFallbackResult<T>;

export function applyHeaderAllowlist(
  headers: Record<string, string>,
  allowedHeaderKeys: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowedHeaderKeys.map((key) => key.toLowerCase()));
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (allowed.has(key.toLowerCase())) {
      output[key] = value;
    }
  }
  return output;
}

export class TemplateCache<K, V> {
  readonly #store = new Map<K, V>();

  get(key: K): V | undefined {
    return this.#store.get(key);
  }

  set(key: K, value: V): void {
    this.#store.set(key, value);
  }

  has(key: K): boolean {
    return this.#store.has(key);
  }

  delete(key: K): boolean {
    return this.#store.delete(key);
  }

  clear(): void {
    this.#store.clear();
  }
}

export function fromNetwork<T>(data: T, reason?: string): NetworkExecutionResult<T> {
  const output: NetworkExecutionResult<T> = {
    source: "network",
    data,
  };
  if (reason !== undefined) {
    output.reason = reason;
  }
  return output;
}

export function fromDomFallback<T>(data: T, reason: string): DomFallbackResult<T> {
  return {
    source: "dom",
    data,
    reason,
  };
}
