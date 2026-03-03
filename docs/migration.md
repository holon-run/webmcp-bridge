# Migration to stdio local-mcp (MVP)

## Breaking changes

- Removed Unix-socket + SSE server/client APIs from `@webmcp-bridge/local-mcp`.
- Removed deprecated `attachBridge` / `detachBridge` APIs from `@webmcp-bridge/playwright`.
- local-mcp now runs as a stdio MCP server process per site session.

## What to use instead

- Start local-mcp via CLI:

```bash
node packages/local-mcp/dist/cli.js --site x
```

- Use `createWebMcpPageGateway` directly when integrating Playwright manually.

## Notes

- Native WebMCP is preferred automatically.
- If native is unavailable, shim + fallback adapter is used automatically.
- local-mcp stdio transport now reuses `@modelcontextprotocol/sdk` (`Server` + `StdioServerTransport`) instead of custom framing code.
