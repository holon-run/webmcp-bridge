# local-mcp CLI

`@webmcp-bridge/local-mcp` runs as a stdio MCP server.
Each process binds one website session and proxies that page's WebMCP tools.

## Usage

```bash
node packages/local-mcp/dist/cli.js --site x [options]
```

## Options

- `--site <site>`: required site id (`x` in MVP).
- `--url <url>`: override the default URL for the site.
- `--browser <name>`: `chromium` | `firefox` | `webkit`.
- `--headless`: launch browser in headless mode.
- `--no-headless`: force headed mode.
- `--user-data-dir <path>`: Playwright persistent profile directory.
- `--service-version <value>`: MCP server version string.
- `--help`: print usage.

## Behavior

- Native-first: if page has native `navigator.modelContext`, calls route to native WebMCP.
- Shim fallback: if native is unavailable, local-mcp injects shim and uses site fallback adapter.
- Stdio transport only in MVP; no Unix socket mode.
