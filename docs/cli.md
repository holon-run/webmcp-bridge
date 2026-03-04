# local-mcp CLI

`@webmcp-bridge/local-mcp` runs as a stdio MCP server.
Each process binds one website session and proxies that page's WebMCP tools.

## Usage

```bash
node packages/local-mcp/dist/cli.js --site <site> [options]
```

## Options

- `--site <site>`: required site id (`x` or `fixture`).
- `--url <url>`: override the adapter default URL (`manifest.defaultUrl`), validated by adapter `hostPatterns`.
- `--browser <name>`: `chromium` | `firefox` | `webkit`.
- `--headless`: launch browser in headless mode.
- `--no-headless`: force headed mode.
- `--auto-login-fallback`: auto-switch to headed mode when auth is required in headless mode (default: true).
- `--no-auto-login-fallback`: disable the auto login fallback.
- `--user-data-dir <path>`: Playwright persistent profile directory.
- `--service-version <value>`: MCP server version string.
- `--help`: print usage.

## Behavior

- Native-first: if page has native `navigator.modelContext`, calls route to native WebMCP.
- Shim fallback: if native is unavailable, local-mcp injects shim and uses site fallback adapter.
- Stdio transport only in MVP; no Unix socket mode.
- URL selection is `--url` first, otherwise adapter `manifest.defaultUrl`; startup fails closed if target host is outside adapter `hostPatterns`.
