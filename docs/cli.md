# local-mcp CLI

`@webmcp-bridge/local-mcp` runs as a stdio MCP server.
Each process binds one website session and proxies that page's WebMCP tools.

> Package status: beta (`0.x`), interfaces may change between minor versions.

## Usage

```bash
node packages/local-mcp/dist/cli.js [--site <site> | --adapter-module <specifier>] [options]
```

## Source selection

- `--site <site>`: use built-in adapter preset (`x`, `google`, or `fixture`).
- `--adapter-module <specifier>`: use external adapter module (`npm` package name, file path, or `file://` URL).
- If neither `--site` nor `--adapter-module` is provided, `--url` runs in native/polyfill mode (no adapter fallback).

## Options

- `--url <url>`: target URL in url mode; otherwise overrides adapter default URL (`manifest.defaultUrl`).
- `--browser <name>`: `chromium` | `firefox` | `webkit`.
- `--browser-channel <name>`: Chromium distribution channel override, such as `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`, or `msedge-canary`.
- `--browser-url <url>`: attach to an existing Chromium browser over CDP instead of launching a new browser.
- `--chromium-login-workaround`: ignore `--enable-automation` for Chromium-based login flows.
- `--headless`: launch browser in headless mode.
- `--no-headless`: force headed mode.
- `--auto-login-fallback`: auto-switch to headed mode when adapter auth probe reports auth required in headless mode (default: true).
- `--no-auto-login-fallback`: disable auto login fallback.
- `--user-data-dir <path>`: Playwright persistent profile directory.
- `--service-version <value>`: MCP server version string.
- `--help`: print usage.

## Behavior

- If the page exposes native `navigator.modelContext`, calls route to native WebMCP; otherwise the bridge falls back to injected adapters.
- Polyfill mode: if native is unavailable, local-mcp injects `navigator.modelContext` compatibility APIs in-page.
- Adapter-shim mode: when adapter source is configured and native is unavailable, fallback adapter logic handles tools.
- Control-only mode: for auth-sensitive sessions that are waiting for bootstrap or attach, local-mcp exposes only reserved `bridge.*` tools and no page tools.
- URL selection is `--url` first, otherwise adapter `manifest.defaultUrl`; startup fails closed if target host is outside adapter `hostPatterns`.
- Stdio transport only in MVP.
- local-mcp exposes a reserved `bridge.*` control namespace in addition to page tools:
  - `bridge.window.open`: focus the current headed browser session, or start a new headed session if the previous window was closed
  - `bridge.session.status`: return local-mcp control-plane state for the current site session
  - `bridge.session.bootstrap`: launch a normal browser for manual sign-in on a managed profile
  - `bridge.session.attach`: attach in CDP mode, either to an explicit `browserUrl` or to a managed attach browser for auth-sensitive sessions
  - `bridge.session.restart`: restart the current bridge session, optionally switching control mode or headless state
  - `bridge.session.stop`: close the current bridge session
  - `bridge.session.reset_profile`: back up and recreate the managed profile for the current session
  - `bridge.open` and `bridge.close` remain available as legacy aliases
- `bridge.window.open` and `bridge.open` return `UNSUPPORTED_IN_HEADLESS_SESSION` when invoked through a headless link.
- If `--browser-channel` is set, `--browser` must remain `chromium`; other engines reject channel overrides.
- If `--browser-url` is set, local-mcp attaches to an already running Chromium browser and does not launch a new profile itself.
- Auth-sensitive adapters declare `manifest.authPolicy`. When `authPolicy.mode = "bootstrap_then_attach"`, local-mcp uses a managed profile and follows this flow:
  1. bootstrap a normal browser for manual sign-in
  2. record lightweight session metadata beside the profile
  3. attach to an authenticated browser over CDP for page automation
- `bridge.session.status` includes:
  - `controlMode`
  - `mode`
  - `authPolicyMode`
  - `authState`
  - `sessionState`
  - `ownership`
  - optional `profilePath`, `browserUrl`, `browserPid`, and `lastBackupPath`

## `uxc` demo shortcut

```bash
uxc link board-webmcp \
  "node packages/local-mcp/dist/cli.js --url https://board.holon.run --headless --user-data-dir ~/.uxc/webmcp-profile/board" \
  --daemon-exclusive ~/.uxc/webmcp-profile/board
```
