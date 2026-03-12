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

Run directly from npm against the public native WebMCP demo:

```bash
npx -y @webmcp-bridge/local-mcp --url https://board.holon.run --headless
```

On a fresh machine, or when running under a brand new `HOME`, install Playwright browsers first:

```bash
npx playwright install
```

Or install globally:

```bash
npm i -g @webmcp-bridge/local-mcp
webmcp-local-mcp --url https://board.holon.run --headless
```

Run from this repository:

```bash
pnpm install
pnpm --filter @webmcp-bridge/local-mcp build
node packages/local-mcp/dist/cli.js --url https://board.holon.run --headless
```

Native WebMCP demo with `uxc` shortcut:

```bash
uxc link board-webmcp \
  "npx -y @webmcp-bridge/local-mcp --url https://board.holon.run --headless --user-data-dir ~/.uxc/webmcp-profile/board" \
  --daemon-exclusive ~/.uxc/webmcp-profile/board

board-webmcp -h --text
```

Built-in fallback adapter mode:

```bash
webmcp-local-mcp --site x --headless
```

Deterministic fixture mode:

```bash
webmcp-local-mcp --site fixture --headless
```

External adapter module mode:

```bash
webmcp-local-mcp --adapter-module @your-scope/webmcp-adapter --headless
```

## Skills

This repository includes three Codex skills with distinct responsibilities:

- `webmcp-bridge`: general bridge operations for existing sites. Use it to decide between `--url`, `--site`, and `--adapter-module`, create fixed `uxc` links, manage per-site profiles, and switch between headless and UI bridge modes.
- `board-webmcp`: site wrapper for the public native demo at `https://board.holon.run`. Use it when the task is specifically about the shared board example.
- `webmcp-adapter-creator`: adapter creation workflow for sites that do not expose native WebMCP. Use it to scaffold a new adapter package, design tool schemas, and implement browser-side request-template execution.

Recommended order:

1. Use `webmcp-bridge` when a site already exposes native WebMCP or already has an adapter.
2. Use `board-webmcp` when the task is specifically about the board demo.
3. Use `webmcp-adapter-creator` when the site has no native WebMCP and no existing fallback adapter.

## Runtime model

![Bridge architecture](docs/images/bridge-architecture.png)

`webmcp-local-mcp` owns one site session per process, drives a Playwright page, and proxies `tools/list` / `tools/call` into browser-side WebMCP execution.

The bridge is native-first:

- native sites execute through browser `navigator.modelContext`
- non-native sites execute through injected WebMCP shim paths

Both paths return standard JSON-serializable MCP payloads to the local caller.

## Adapter authoring

See [Adapter Authoring](docs/adapters/authoring.md) for:

- `manifest + createAdapter` module contract
- tool naming and schema guidelines
- pagination/error shape conventions
- fail-closed adapter requirements

## Native Example App

`examples/board` is a native WebMCP provider example built as a browser app, not an adapter.

Public demo:

```bash
webmcp-local-mcp --url https://board.holon.run --headless
```

Run it locally:

```bash
pnpm --filter @webmcp-bridge/example-board dev
```

Then connect through the existing bridge:

```bash
webmcp-local-mcp --url http://127.0.0.1:4173 --headless
```

This example is meant to demonstrate human + AI collaboration on the same diagram surface.

## Development

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Publish to npm

Use `pnpm publish` from this monorepo so workspace protocol dependencies are rewritten to concrete versions in published tarballs.

```bash
pnpm -r --filter "@webmcp-bridge/*" publish --access public
```

For a dry run:

```bash
pnpm -r --filter "@webmcp-bridge/*" publish --dry-run
```

## Constraints

- Assumes users are already authenticated in the browser session.
- Does not implement credential vaulting or auth bypass.
- Target URL defaults to adapter manifest and can be overridden by CLI, but must match adapter host allowlist.
