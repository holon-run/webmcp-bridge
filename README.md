# webmcp-bridge

`webmcp-bridge` provides a local-to-browser bridge for WebMCP tool calling.
The primary runtime path is `local-mcp (stdio MCP) -> playwright -> browser navigator.modelContext`
with native-first behavior and shim fallback.

## Packages

- `@webmcp-bridge/core`: shared modelContext shim/runtime contracts used by fallback paths.
- `@webmcp-bridge/playwright`: browser WebMCP page gateway (native-first, shim fallback).
- `@webmcp-bridge/adapter-x`: production fallback adapter for X/Twitter workflows.
- `@webmcp-bridge/adapter-fixture`: deterministic fallback adapter for integration/contract tests.
- `@webmcp-bridge/local-mcp`: one-site stdio MCP server that boots Playwright and proxies `tools/list` / `tools/call` into a browser page gateway.
- `@webmcp-bridge/testkit`: shared contract test helpers.

## Runtime model

1. A local MCP host launches `webmcp-local-mcp` as a stdio MCP server for one site session.
2. `local-mcp` launches a Playwright browser/page and opens the target site.
3. `local-mcp` creates a WebMCP page gateway and proxies MCP tool list/call requests to that page.
4. The page gateway prefers native `navigator.modelContext` when available.
5. If native WebMCP is unavailable, the gateway installs shim behavior and delegates calls to fallback adapter logic.
6. Results are returned as JSON-serializable MCP payloads.

## CLI (MVP)

```bash
pnpm --filter @webmcp-bridge/local-mcp build
node packages/local-mcp/dist/cli.js --site x --headless
# deterministic test site
node packages/local-mcp/dist/cli.js --site fixture --headless
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Constraints

- Only supports actions in already-authenticated user sessions.
- Does not manage credentials or bypass platform controls.
- Target URL defaults to adapter manifest and can be overridden by CLI, but must match adapter host allowlist.
