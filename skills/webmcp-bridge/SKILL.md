---
name: webmcp-bridge
description: Connect a website to the local-mcp browser bridge through a fixed UXC link. Use when the user needs to operate native WebMCP sites or adapter-backed sites through local-mcp, manage per-site browser profiles, or switch bridge presentation modes explicitly.
---

# WebMCP Bridge

Use this skill to operate `@webmcp-bridge/local-mcp` through one fixed `uxc` shortcut command per site.

Keep this skill thin: prefer the published docs for behavior details, and use the docs search API before guessing.

## Prerequisites

- `uxc` is installed and available in `PATH`.
- `npx` is installed and available in `PATH`.
- Network access is available for the target website.
- On a fresh machine or isolated `HOME`, install Playwright browsers with `npx playwright install`.
- For local repo development, you may replace the default launcher with `WEBMCP_LOCAL_MCP_COMMAND='node packages/local-mcp/dist/cli.js'`.

## Docs Search

Docs site:

- `https://webmcp-bridge.holon.run`

Docs search API:

- `https://webmcp-bridge.holon.run/api/search?q=<query>`

Typical searches:

- `session lifecycle`
- `bridge.overlay.export`
- `overlay-bootstrap`
- `bridge.session.attach`

## Quick Workflow

1. Pick the source mode:
   - native/polyfill target: `--url <url>`
   - built-in fallback adapter: `--site <site>`
   - third-party adapter: `--adapter-module <specifier>` and optionally `--url <url>`
2. Use one site-scoped profile:
   - `~/.uxc/webmcp-profile/<site>`
3. Create or refresh the fixed link:
   - `command -v <site>-webmcp-cli`
   - `skills/webmcp-bridge/scripts/ensure-links.sh --name <site> ...`
4. Inspect help before calling tools:
   - `<site>-webmcp-cli -h`
   - `<site>-webmcp-cli <operation> -h`
   - `<site>-webmcp-cli <operation> field=value`
   - `<site>-webmcp-cli <operation> '{"field":"value"}'`
5. Treat presentation mode as live state, not launcher intent:
   - `<site>-webmcp-cli bridge.session.status`
   - `<site>-webmcp-cli bridge.session.mode.get`
   - `<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
   - `<site>-webmcp-cli bridge.open`

## When Only `bridge.*` Tools Are Visible

Start with:

- `<site>-webmcp-cli bridge.session.status`

Then follow the state:

- bootstrap/auth incomplete: `<site>-webmcp-cli bridge.session.bootstrap`
- existing profile/browser should attach: `<site>-webmcp-cli bridge.session.attach`
- adapterless/native-missing page in `overlay-bootstrap`: use
  - `<site>-webmcp-cli bridge.debug.eval '{"script":"() => document.title"}'`
  - `<site>-webmcp-cli bridge.overlay.install '{"id":"draft","tools":[{"name":"page.title.get","script":"() => ({ title: document.title })"}]}'`
  - `<site>-webmcp-cli bridge.overlay.update '{"id":"draft","activation":"override"}'`
  - `<site>-webmcp-cli bridge.overlay.export '{"id":"draft"}'`

Do not switch to `$webmcp-adapter-creator` just because a page has no formal adapter yet. Use overlay bootstrap first; switch to adapter creation when you want to promote a stable reusable adapter.

## Canonical Docs

- CLI reference:
  - `https://webmcp-bridge.holon.run/reference/cli`
- Session lifecycle:
  - `https://webmcp-bridge.holon.run/reference/session-lifecycle`
- Architecture:
  - `https://webmcp-bridge.holon.run/reference/architecture`
- Adapter authoring:
  - `https://webmcp-bridge.holon.run/adapters`
- Docs search API:
  - `https://webmcp-bridge.holon.run/api/search?q=<query>`

## Local References

- Usage patterns:
  - `references/usage-patterns.md`
- Source modes:
  - `references/source-modes.md`
- Link patterns:
  - `references/link-patterns.md`
- Troubleshooting:
  - `references/troubleshooting.md`
- Link creation helper:
  - `scripts/ensure-links.sh`

## Guardrails

- Prefer browser-side execution for privileged site actions. Do not move site credentials into local scripts.
- Do not share one `--user-data-dir` across unrelated sites.
- Use `bridge.session.mode.set` for managed sessions instead of assuming a fresh launcher invocation changes the live runtime.
- External attach sessions cannot be mode-switched by the bridge.
- `bridge.open` and `bridge.window.open` fail in headless sessions.
- For destructive writes, inspect tool help first and require explicit user intent.
- If behavior still looks wrong after checking the docs search, open an issue:
  - `https://github.com/holon-run/webmcp-bridge/issues`
