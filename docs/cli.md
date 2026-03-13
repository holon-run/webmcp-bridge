# local-mcp CLI

`@webmcp-bridge/local-mcp` runs as a stdio MCP server.
Each process binds one website session and proxies that page's WebMCP tools.

> Package status: beta (`0.x`), interfaces may change between minor versions.

## Usage

```bash
node packages/local-mcp/dist/cli.js [--site <site> | --adapter-module <specifier>] [options]
```

## Source selection

- `--site <site>`: use built-in adapter preset (`x` or `fixture`).
- `--adapter-module <specifier>`: use external adapter module (`npm` package name, file path, or `file://` URL).
- If neither `--site` nor `--adapter-module` is provided, `--url` runs in native/polyfill mode (no adapter fallback).

## Options

- `--url <url>`: target URL in url mode; otherwise overrides adapter default URL (`manifest.defaultUrl`).
- `--browser <name>`: `chromium` | `firefox` | `webkit`.
- `--browser-channel <name>`: Chromium distribution channel override, such as `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`, or `msedge-canary`.
- `--headless`: launch browser in headless mode.
- `--no-headless`: force headed mode.
- `--auto-login-fallback`: auto-switch to headed mode when adapter auth probe reports auth required in headless mode (default: true).
- `--no-auto-login-fallback`: disable auto login fallback.
- `--user-data-dir <path>`: Playwright persistent profile directory.
- `--service-version <value>`: MCP server version string.
- `--help`: print usage.

## Behavior

- Native-first: if page has native `navigator.modelContext`, calls route to native WebMCP.
- Polyfill mode: if native is unavailable, local-mcp injects `navigator.modelContext` compatibility APIs in-page.
- Adapter-shim mode: when adapter source is configured and native is unavailable, fallback adapter logic handles tools.
- URL selection is `--url` first, otherwise adapter `manifest.defaultUrl`; startup fails closed if target host is outside adapter `hostPatterns`.
- Stdio transport only in MVP.
- local-mcp always exposes two bridge control tools in addition to page tools:
  - `bridge.open`: focus the current headed browser session
  - `bridge.close`: close the current bridge session
- `bridge.open` returns `UNSUPPORTED_IN_HEADLESS_SESSION` when invoked through a headless link.
- If `--browser-channel` is set, `--browser` must remain `chromium`; other engines reject channel overrides.

## `uxc` demo shortcut

```bash
uxc link board-webmcp \
  "node packages/local-mcp/dist/cli.js --url https://board.holon.run --headless --user-data-dir ~/.uxc/webmcp-profile/board" \
  --daemon-exclusive ~/.uxc/webmcp-profile/board
```
