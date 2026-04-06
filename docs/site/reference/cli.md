# CLI And Control Plane

`@webmcp-bridge/local-mcp` is the stdio MCP entrypoint.

One process manages one site session.

## Main Flags

- `--url <url>`: native or polyfill mode
- `--site <site>`: built-in adapter preset such as `x`, `google`, or `fixture`
- `--adapter-module <specifier>`: third-party adapter module
- `--user-data-dir <path>`: persistent browser profile
  If omitted on managed launches, local-mcp defaults to `~/.uxc/webmcp-profile/<site-or-host>`.
- `--headless`: prefer headless presentation
- `--no-headless`: prefer headed presentation
- `--browser-url <url>`: attach to an existing Chromium browser over CDP

## Bridge Tools

`local-mcp` always reserves the `bridge.*` namespace:

- `bridge.session.status`
- `bridge.session.bootstrap`
- `bridge.session.attach`
- `bridge.session.mode.get`
- `bridge.session.mode.set`
- `bridge.session.stop`
- `bridge.session.reset_profile`
- `bridge.debug.eval`
- `bridge.overlay.list`
- `bridge.overlay.install`
- `bridge.overlay.update`
- `bridge.overlay.enable`
- `bridge.overlay.disable`
- `bridge.overlay.delete`
- `bridge.window.open`
- `bridge.open`
- `bridge.close`

## Key Session Fields

`bridge.session.status` may report:

- `controlMode`
- `mode`
- `presentationMode`
- `preferredPresentationMode`
- `authPolicyMode`
- `authState`
- `sessionState`
- `ownership`
- optional `profilePath`, `browserUrl`, `browserPid`, and `lastBackupPath`

## Important Behavior

- launcher flags only set preferred defaults
- live mode is the current `presentationMode`
- `bridge.open` is only valid in `headed` sessions
- auth-sensitive sites may temporarily expose only `bridge.*` tools while waiting for bootstrap or attach
- adapterless pages may enter `overlay-bootstrap` mode and expose only bridge tools plus `overlay.<id>.*` tools that you install

## Next

- [Bridge Session Model](./session-lifecycle.md)
- [Architecture](./architecture.md)
