# webmcp-bridge

`webmcp-bridge` provides a local-to-browser bridge for WebMCP tool calling.

Primary runtime path:
`local-mcp (stdio MCP) -> playwright -> browser navigator.modelContext`

The runtime is native-first: if the page exposes native WebMCP, calls go to native APIs; otherwise the fallback adapter path is used.

## Package status

- `@webmcp-bridge/core`: shared bridge contracts and shim runtime.
- `@webmcp-bridge/playwright`: WebMCP page gateway for Playwright.
- `@webmcp-bridge/adapter-x`: production fallback adapter for X/Twitter.
- `@webmcp-bridge/adapter-fixture`: deterministic fallback adapter for integration/contract tests.
- `@webmcp-bridge/testkit`: shared contract test helpers.
- `@webmcp-bridge/local-mcp`: local stdio MCP server (public beta package, rapid iteration expected).

## Quick start

```bash
pnpm install
pnpm --filter @webmcp-bridge/local-mcp build
node packages/local-mcp/dist/cli.js --url https://www.meetcursive.com --headless
```

Native WebMCP demo with `uxc` shortcut:

```bash
uxc link cursive-webmcp \
  "node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js --url https://www.meetcursive.com --headless --user-data-dir ~/.uxc/playwright-profile" \
  --daemon-exclusive ~/.uxc/playwright-profile

cursive-webmcp -h --text
```

Built-in fallback adapter mode:

```bash
node packages/local-mcp/dist/cli.js --site x --headless
```

Deterministic fixture mode:

```bash
node packages/local-mcp/dist/cli.js --site fixture --headless
```

External adapter module mode:

```bash
node packages/local-mcp/dist/cli.js --adapter-module @your-scope/webmcp-adapter --headless
```

## Runtime model

1. A local MCP host launches `webmcp-local-mcp` for one site session.
2. `local-mcp` starts a Playwright persistent context and opens the target URL.
3. `local-mcp` creates a page gateway and proxies MCP `tools/list` and `tools/call`.
4. The gateway uses native `navigator.modelContext` when available.
5. If native WebMCP is unavailable, shim + adapter fallback handles tool execution.
6. Results are returned as JSON-serializable MCP payloads.

## Adapter authoring

See [Adapter Authoring](docs/adapters/authoring.md) for:

- `manifest + createAdapter` module contract
- tool naming and schema guidelines
- pagination/error shape conventions
- fail-closed adapter requirements

## Development

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Constraints

- Assumes users are already authenticated in the browser session.
- Does not implement credential vaulting or auth bypass.
- Target URL defaults to adapter manifest and can be overridden by CLI, but must match adapter host allowlist.
