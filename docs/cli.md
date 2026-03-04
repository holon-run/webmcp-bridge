# local-mcp CLI

`@webmcp-bridge/local-mcp` runs as a stdio MCP server.
Each process binds one website session and proxies that page's WebMCP tools.

> Package status: beta (`0.x`), interfaces may change between minor versions.

## Usage

```bash
node packages/local-mcp/dist/cli.js (--site <site> | --adapter-module <specifier>) [options]
```

## Source selection

- `--site <site>`: use built-in adapter preset (`x` or `fixture`).
- `--adapter-module <specifier>`: use external adapter module (`npm` package name, file path, or `file://` URL).
- Exactly one of `--site` or `--adapter-module` must be provided.

## Options

- `--url <url>`: override adapter default URL (`manifest.defaultUrl`), validated by adapter `hostPatterns`.
- `--browser <name>`: `chromium` | `firefox` | `webkit`.
- `--headless`: launch browser in headless mode.
- `--no-headless`: force headed mode.
- `--auto-login-fallback`: auto-switch to headed mode when adapter auth probe reports auth required in headless mode (default: true).
- `--no-auto-login-fallback`: disable auto login fallback.
- `--user-data-dir <path>`: Playwright persistent profile directory.
- `--service-version <value>`: MCP server version string.
- `--help`: print usage.

## Behavior

- Native-first: if page has native `navigator.modelContext`, calls route to native WebMCP.
- Shim fallback: if native is unavailable, local-mcp uses fallback adapter logic.
- URL selection is `--url` first, otherwise adapter `manifest.defaultUrl`; startup fails closed if target host is outside adapter `hostPatterns`.
- Stdio transport only in MVP.
