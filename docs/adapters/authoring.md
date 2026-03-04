# Adapter Authoring

This document defines the contract for third-party fallback adapters used by `@webmcp-bridge/local-mcp`.

## Module contract

An adapter module must export:

- `manifest`: adapter metadata and URL host guard.
- `createAdapter()`: adapter factory returning a `SiteAdapter` implementation.

Type-level shape (from `@webmcp-bridge/playwright`):

```ts
export type AdapterManifest = {
  id: string;
  displayName: string;
  version: string;
  bridgeApiVersion: string;
  defaultUrl?: string;
  hostPatterns: string[];
  authProbeTool?: string;
};

export type SiteAdapter = {
  name: string;
  listTools: (context: { page: Page }) => Promise<Array<WebMcpToolDefinition>>;
  callTool: (
    request: { name: string; input: JsonValue },
    context: { page: Page },
  ) => Promise<JsonValue>;
  start?: (context: { page: Page }) => Promise<void>;
  stop?: (context: { page: Page }) => Promise<void>;
};
```

## Minimal example

```ts
import type { AdapterManifest } from "@webmcp-bridge/playwright";
import type { SiteAdapter } from "@webmcp-bridge/playwright";

export const manifest: AdapterManifest = {
  id: "example.com",
  displayName: "Example",
  version: "0.1.0",
  bridgeApiVersion: "1.0.0",
  defaultUrl: "https://example.com",
  hostPatterns: ["example.com", "www.example.com"],
  authProbeTool: "auth.get",
};

export function createAdapter(): SiteAdapter {
  return {
    name: "adapter-example",
    listTools: async () => [
      {
        name: "auth.get",
        description: "Detect auth status",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async ({ name }) => {
      if (name === "auth.get") {
        return { state: "authenticated" };
      }
      return {
        error: {
          code: "TOOL_NOT_FOUND",
          message: `unknown tool: ${name}`,
        },
      };
    },
  };
}
```

Run with:

```bash
webmcp-local-mcp --adapter-module @your-scope/webmcp-adapter --headless
```

## Naming and schema guidance

- Use stable, product-oriented names: `tweet.get`, `timeline.home.list`, `user.get`.
- Use JSON-schema-like `inputSchema` with descriptions for required fields.
- Keep tool descriptions focused on behavior; parameter details belong in schema field descriptions.

## Response conventions

- All payloads must be JSON-serializable.
- Success payload: object containing stable fields.
- Error payload: use `{ error: { code, message, details? } }`.
- Pagination tools should follow:
- input: `limit`, optional `cursor`
- output: `items`, `hasMore`, optional `nextCursor`
- include `source` (`network` | `dom`) when dual-path extraction exists

## Auth probe and headless fallback

- If your adapter supports auth probing, set `manifest.authProbeTool` to a read-only tool (for example `auth.get`).
- When `--auto-login-fallback` is enabled, local-mcp will call this tool in headless mode and retry in headed mode if it returns `auth_required` or `challenge_required`.

## Safety expectations

- Assume user already authenticated in browser profile.
- Do not implement credential vaulting or auth bypass.
- Fail closed on ambiguous upstream states (`AUTH_REQUIRED`, `UPSTREAM_CHANGED`, `CHALLENGE_REQUIRED`).
- Keep site-specific constants and heuristics inside adapter package only.
