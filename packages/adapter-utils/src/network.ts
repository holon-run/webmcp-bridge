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

export type CapturedRequestEntry = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  responseJson?: unknown;
  ts?: number;
  status?: number;
  ok?: boolean;
  [key: string]: unknown;
};

export type RequestCaptureScriptOptions = {
  globalKey: string;
  shouldCaptureSource: string;
  enrichEntrySource?: string;
  maxEntries?: number;
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

export function toRequestTemplate(entry: CapturedRequestEntry): RequestTemplate | undefined {
  if (typeof entry.url !== "string" || typeof entry.method !== "string") {
    return undefined;
  }
  const template: RequestTemplate = {
    url: entry.url,
    method: entry.method,
  };
  if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
    template.headers = entry.headers;
  }
  if (typeof entry.body === "string") {
    template.body = entry.body;
  }
  return template;
}

export function selectLatestRequestTemplate(
  entries: readonly CapturedRequestEntry[],
  matcher: (entry: CapturedRequestEntry) => boolean,
): RequestTemplate | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || !matcher(entry)) {
      continue;
    }
    const template = toRequestTemplate(entry);
    if (template) {
      return template;
    }
  }
  return undefined;
}

export function buildRequestCaptureInitScript(options: RequestCaptureScriptOptions): string {
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.floor(options.maxEntries ?? 80)) : 80;
  const enrichEntrySource = options.enrichEntrySource ?? "((entry) => entry)";
  return String.raw`
(() => {
  const globalAny = window;
  if (globalAny[${JSON.stringify(options.globalKey)}]) {
    return;
  }

  const state = {
    enabled: true,
    entries: [],
  };

  const now = () => Date.now();
  const shouldCapture = ${options.shouldCaptureSource};
  const enrichEntry = ${enrichEntrySource};
  const maxEntries = ${String(maxEntries)};

  const pickHeaders = (headersLike) => {
    const output = {};
    if (!headersLike) return output;
    try {
      const headers = new Headers(headersLike);
      headers.forEach((value, key) => {
        output[String(key).toLowerCase()] = String(value);
      });
      return output;
    } catch {
      if (typeof headersLike === "object") {
        for (const [k, v] of Object.entries(headersLike)) {
          output[String(k).toLowerCase()] = String(v);
        }
      }
      return output;
    }
  };

  const appendEntry = (entry) => {
    const nextEntry = enrichEntry(entry);
    if (!nextEntry || typeof nextEntry !== "object") {
      return;
    }
    state.entries.push(nextEntry);
    if (state.entries.length > maxEntries) {
      state.entries.splice(0, state.entries.length - maxEntries);
    }
  };

  const originalFetch = globalAny.fetch?.bind(globalAny);
  if (typeof originalFetch === "function") {
    globalAny.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url || "";
      const method = String(init.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
      const headers = pickHeaders(init.headers || (typeof input !== "string" ? input?.headers : undefined));
      const body = typeof init.body === "string" ? init.body : undefined;
      const response = await originalFetch(...args);

      if (shouldCapture(url, method)) {
        let responseJson;
        try {
          responseJson = await response.clone().json();
        } catch {
          responseJson = undefined;
        }
        appendEntry({
          ts: now(),
          url,
          method,
          headers,
          body,
          ok: response.ok,
          status: response.status,
          responseJson,
        });
      }
      return response;
    };
  }

  const OriginalXMLHttpRequest = globalAny.XMLHttpRequest;
  const xhrProto = OriginalXMLHttpRequest?.prototype;
  if (xhrProto && !xhrProto.__webmcpCapturePatched) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    const originalSetRequestHeader = xhrProto.setRequestHeader;

    xhrProto.open = function(method, url, ...rest) {
      this.__webmcpCapture = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        headers: {},
      };
      return originalOpen.call(this, method, url, ...rest);
    };

    xhrProto.setRequestHeader = function(key, value) {
      try {
        const capture = this.__webmcpCapture;
        if (capture && capture.headers && typeof key === "string") {
          capture.headers[String(key).toLowerCase()] = String(value);
        }
      } catch {}
      return originalSetRequestHeader.call(this, key, value);
    };

    xhrProto.send = function(body) {
      try {
        this.addEventListener("loadend", () => {
          const capture = this.__webmcpCapture || {};
          const url = typeof capture.url === "string" ? capture.url : "";
          const method = typeof capture.method === "string" ? capture.method : "GET";
          if (!shouldCapture(url, method)) {
            return;
          }
          let responseJson;
          try {
            const text = typeof this.responseText === "string" ? this.responseText : "";
            responseJson = text ? JSON.parse(text) : undefined;
          } catch {
            responseJson = undefined;
          }
          appendEntry({
            ts: now(),
            url,
            method,
            headers: capture.headers || {},
            body: typeof body === "string" ? body : undefined,
            ok: this.status >= 200 && this.status < 300,
            status: Number(this.status || 0),
            responseJson,
          });
        });
      } catch {}
      return originalSend.call(this, body);
    };

    xhrProto.__webmcpCapturePatched = true;
  }

  globalAny[${JSON.stringify(options.globalKey)}] = state;
})();
`;
}
