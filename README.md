# webmcp-bridge

`webmcp-bridge` provides a compatibility bridge for websites that do not yet expose native `navigator.modelContext`.

## Packages

- `@webmcp-bridge/core`: in-page model context shim/runtime.
- `@webmcp-bridge/playwright`: Playwright bridge lifecycle and page<->Node transport.
- `@webmcp-bridge/adapter-x`: starter adapter for X/Twitter style workflows.
- `@webmcp-bridge/local-mcp`: local MCP host/client over Unix socket with JSON-RPC + SSE replay.
- `@webmcp-bridge/testkit`: shared contract test helpers.

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
