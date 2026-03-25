# Getting Started

This guide is the shortest path to a working local bridge session.

## Choose A Source Mode

- Native or polyfill site: run `local-mcp` with `--url`
- Built-in adapter site: run `local-mcp` with `--site`
- External adapter package: run `local-mcp` with `--adapter-module`

## Before You Start

Use the bridge only for research, development, testing, and normal authorized user flows. Do not use repository-provided adapters for unauthorized scraping, access-control bypass, or abusive automation against third-party services.

## Direct CLI

Run a native site directly:

```bash
node packages/local-mcp/dist/cli.js --url https://board.holon.run --headless
```

Run X through the built-in adapter:

```bash
node packages/local-mcp/dist/cli.js --site x --headless --user-data-dir ~/.uxc/webmcp-profile/x
```

Run Google or Gemini through the built-in adapter:

```bash
node packages/local-mcp/dist/cli.js --site google --headless --user-data-dir ~/.uxc/webmcp-profile/google
```

## Fixed Site Links

For daily usage, prefer one stable `uxc` link per site:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh --name board --url https://board.holon.run
skills/x-webmcp/scripts/ensure-links.sh
skills/google-webmcp/scripts/ensure-links.sh
```

This creates commands such as:

- `board-webmcp-cli`
- `x-webmcp-cli`
- `google-webmcp-cli`

## First Commands

Check the tool schema first:

```bash
<site>-webmcp-cli -h
<site>-webmcp-cli <operation> -h
```

Inspect the current bridge session:

```bash
<site>-webmcp-cli bridge.session.status
```

If the site needs a visible browser:

```bash
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
```

## Next

- [CLI And Control Plane](../reference/cli.md)
- [Bridge Session Model](../reference/session-lifecycle.md)
- [Skills](../skills/)

<!-- INDEX:START -->

<!-- INDEX:END -->
