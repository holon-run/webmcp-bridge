# webmcp-bridge

`webmcp-bridge` lets a local MCP client call browser WebMCP tools through a stable local bridge.

Primary runtime path:
`local-mcp (stdio MCP) -> playwright -> browser navigator.modelContext`

The bridge uses native WebMCP when available, and falls back to injected adapters when not:

- if the page exposes native WebMCP, calls go to browser `navigator.modelContext`
- if the page does not, the bridge falls back to an injected adapter path

This gives local MCP clients one call path for both:

- native WebMCP sites
- non-native sites that need a shim

## Why this exists

Without a bridge, local MCP clients cannot directly use browser-only WebMCP capabilities such as:

- tools exposed by a live website in the current browser session
- tools that depend on existing site authentication
- human + AI collaboration on the same page

`webmcp-bridge` keeps execution in the browser where those capabilities already exist, while exposing a normal local stdio MCP surface to the caller.

## Who this is for

- MCP client authors who need a stable local bridge to browser WebMCP
- browser app authors who want to expose native WebMCP tools
- adapter authors who want a fallback path for sites without native WebMCP yet

## What you can do with it

- connect a local MCP client to a native WebMCP website
- inject a fallback adapter for sites that do not expose WebMCP yet
- reuse the same logged-in browser session instead of moving credentials into the local process
- run headless automation or open a visible browser window for human + AI collaboration

## When to use which mode

- `--url <https://site>`: the site already exposes native WebMCP
- `--site <name>`: use a built-in fallback adapter such as `x`
- `--adapter-module <specifier>`: use a third-party adapter package

## First 2 minutes

If your main workflow is "agent operates the site for me", install the skills in [Codex skills](#codex-skills) first.

If you prefer direct CLI use instead of agent + skill use, start here:

Run directly from npm against the public native WebMCP demo:

```bash
npx -y @webmcp-bridge/local-mcp --url https://board.holon.run --headless
```

To open a visible browser window for collaboration:

```bash
npx -y @webmcp-bridge/local-mcp --url https://board.holon.run --no-headless
```

With `uxc`, create stable shortcuts:

```bash
uxc link board-webmcp-cli \
  "npx -y @webmcp-bridge/local-mcp --url https://board.holon.run --headless --user-data-dir ~/.uxc/webmcp-profile/board" \
  --daemon-exclusive ~/.uxc/webmcp-profile/board

uxc link board-webmcp-ui \
  "npx -y @webmcp-bridge/local-mcp --url https://board.holon.run --no-headless --user-data-dir ~/.uxc/webmcp-profile/board" \
  --daemon-exclusive ~/.uxc/webmcp-profile/board
```

Then:

```bash
board-webmcp-ui bridge.open
board-webmcp-ui diagram.get
```

Expected result:

- `board-webmcp-ui bridge.open` opens a visible browser session for the board demo
- `board-webmcp-ui diagram.get` returns the current board state as JSON

## Quick start details

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

## Runtime model

![Bridge architecture](docs/images/bridge-architecture.png)

`webmcp-local-mcp` owns one site session per process, drives a Playwright page, and proxies `tools/list` / `tools/call` into browser-side WebMCP execution.

The bridge uses native WebMCP when available, and falls back to injected adapters when not:

- native sites execute through browser `navigator.modelContext`
- non-native sites execute through injected WebMCP shim paths

Both paths return standard JSON-serializable MCP payloads to the local caller.

## Collaborative board demo

The public demo at `https://board.holon.run` is the easiest way to see human + AI collaboration on the same WebMCP surface.

- open a visible session with `board-webmcp-ui bridge.open`
- keep AI tool calls on `board-webmcp-ui` while the human is collaborating in the same visible session
- keep the browser open while the human and the AI work on the same diagram

See [examples/board/README.md](examples/board/README.md) for the full collaboration flow in Codex / Claude Code.

## Package status

- `@webmcp-bridge/core`: shared bridge contracts and shim runtime.
- `@webmcp-bridge/playwright`: WebMCP page gateway for Playwright.
- `@webmcp-bridge/adapter-x`: production fallback adapter for X/Twitter.
- `@webmcp-bridge/adapter-fixture`: deterministic fallback adapter for integration/contract tests.
- `@webmcp-bridge/testkit`: shared contract test helpers.
- `@webmcp-bridge/local-mcp`: local stdio MCP server.

## Codex skills

If you use Codex, install the `uxc` skill first, then install the bridge skills from this repository:

```bash
npx -y skills@latest add https://github.com/holon-run/uxc/tree/main/skills/uxc
npx -y skills@latest add https://github.com/holon-run/webmcp-bridge/tree/main/skills/webmcp-bridge
npx -y skills@latest add https://github.com/holon-run/webmcp-bridge/tree/main/skills/board-webmcp
npx -y skills@latest add https://github.com/holon-run/webmcp-bridge/tree/main/skills/webmcp-adapter-creator
```

The bridge skills depend on `uxc` because they create and use stable `uxc link` commands such as:

- `board-webmcp-cli`
- `board-webmcp-ui`

Recommended skill flow:

1. Use `webmcp-bridge` for general site connection and link creation.
2. Use `board-webmcp` for the public board demo at `https://board.holon.run`.
3. Use `webmcp-adapter-creator` when a site has no native WebMCP and no existing adapter.

## Repository skills

This repository includes three Codex skills with distinct responsibilities:

- `webmcp-bridge`: general bridge operations for existing sites. Use it to decide between `--url`, `--site`, and `--adapter-module`, create fixed `uxc` links, manage per-site profiles, and switch between headless and UI bridge modes.
- `board-webmcp`: site wrapper for the public native demo at `https://board.holon.run`. Use it when the task is specifically about the shared board example.
- `webmcp-adapter-creator`: adapter creation workflow for sites that do not expose native WebMCP. Use it to scaffold a new adapter package, design tool schemas, and implement browser-side request-template execution.

These skills assume the `uxc` CLI and the `uxc` skill are already installed.

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

Useful board tools:

- `bridge.open` / `bridge.close`
- `diagram.get` / `diagram.loadDemo` / `diagram.setTitle` / `diagram.export`
- `nodes.*`
- `edges.*`
- `selection.get` / `selection.remove`
- `view.fit`

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
