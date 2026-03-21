# Migration to stdio local-mcp (MVP)

## Breaking changes

- Removed Unix-socket + SSE server/client APIs from `@webmcp-bridge/local-mcp`.
- Removed deprecated `attachBridge` / `detachBridge` APIs from `@webmcp-bridge/playwright`.
- local-mcp now runs as a stdio MCP server process per site session.

## What to use instead

- Start local-mcp via CLI:

```bash
node packages/local-mcp/dist/cli.js --site x --no-headless --user-data-dir ~/.uxc/webmcp-profile/x
```

- Use `createWebMcpPageGateway` directly when integrating Playwright manually.

## Notes

- Native WebMCP is preferred automatically.
- If native is unavailable, shim + fallback adapter is used automatically.
- Auth-sensitive adapters such as `x` and `google` now use managed profile bootstrap/attach lifecycle instead of Playwright-driven login startup.
- local-mcp stdio transport now reuses `@modelcontextprotocol/sdk` (`Server` + `StdioServerTransport`) instead of custom framing code.
