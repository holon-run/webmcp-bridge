---
name: webmcp-bridge
description: Connect a website to the local-mcp browser bridge through a fixed UXC link. Use when the user needs to operate native WebMCP sites or adapter-backed sites through local-mcp, manage per-site browser profiles, or switch bridge presentation modes explicitly.
---

# WebMCP Bridge

Use this skill to operate `@webmcp-bridge/local-mcp` through one fixed `uxc` shortcut command per site.

If the target site does not expose native WebMCP and does not already have a fallback adapter, switch to `$webmcp-adapter-creator`.

## Prerequisites

- `uxc` is installed and available in `PATH`.
- `npx` is installed and available in `PATH`.
- Network access is available for the target website.
- On a fresh machine, or under an isolated `HOME`, install Playwright browsers first with `npx playwright install`.
- For local repo development, you may replace the default `npx -y @webmcp-bridge/local-mcp` launcher with `WEBMCP_LOCAL_MCP_COMMAND='node packages/local-mcp/dist/cli.js'`.

## Core Workflow

1. Identify the bridge source mode before creating any link:
   - Native or polyfill target: use `--url <url>`.
   - Built-in adapter preset: use `--site <site>`.
   - Third-party adapter module: use `--adapter-module <specifier>` and optionally `--url <url>`.
2. Pick one stable site name and one site-scoped profile path:
   - default profile root: `~/.uxc/webmcp-profile/<site>`
   - never share one profile across different sites
3. Create or refresh the fixed link for that site:
   - `command -v <site>-webmcp-cli`
   - if the link is missing or the source config changed, run `skills/webmcp-bridge/scripts/ensure-links.sh`
4. Inspect the bridge and tool schema before calling tools:
   - `<site>-webmcp-cli -h`
   - `<site>-webmcp-cli <operation> -h`
   - `<site>-webmcp-cli <operation> field=value`
   - `<site>-webmcp-cli <operation> '{"field":"value"}'`
5. Treat presentation mode as explicit runtime state, not command-name intent:
   - check current state with `<site>-webmcp-cli bridge.session.status`
   - or `<site>-webmcp-cli bridge.session.mode.get`
   - `--headless` or `--no-headless` only sets the preferred default for bridge-managed sessions
   - the actual runtime mode is `presentationMode`
6. Switch modes explicitly when needed:
   - for normal automation, stay in `headless`
   - for login, MFA, or human collaboration, run `<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
   - then open or focus the visible session with `<site>-webmcp-cli bridge.open`
   - if the user manually closes that window, the headed owner session ends; run `bridge.open` again to start a new headed session on the same profile
   - close the visible owner session with `<site>-webmcp-cli bridge.close`
7. Parse JSON output only:
   - success path: `.ok == true`, consume `.data`
   - failure path: `.ok == false`, inspect `.error.code` and `.error.message`

## Link Contract

Every site gets one fixed command:

- `<site>-webmcp-cli`

The link must keep one stable site profile and daemon lock:

- profile path: `~/.uxc/webmcp-profile/<site>`
- daemon key: same as profile path

The generated command should default to:

- use `--headless`
- use `--no-auto-login-fallback`

This keeps automation deterministic while still allowing runtime switching through:

- `bridge.session.mode.get`
- `bridge.session.mode.set`
- `bridge.open`
- `bridge.close`

Do not treat one command invocation as a guarantee that the current runtime has already switched. Always inspect `presentationMode` when mode matters.

## Guardrails

- Prefer browser-side execution for privileged site actions. Do not move site credentials into local scripts.
- Do not share one `--user-data-dir` across multiple unrelated sites.
- Do not dynamically rename link commands at runtime. The skill author chooses the link name once.
- For managed sessions, use `bridge.session.mode.set` instead of relying on a new launcher invocation to force a mode change.
- For external attach sessions, `bridge.session.mode.set` is unavailable. Attach to a headed external browser if the task needs a visible window.
- During `bootstrap_then_attach`, bootstrap is always `headed`. Do not try to switch mode until attach completes.
- `bridge.open` and `bridge.window.open` return `UNSUPPORTED_IN_HEADLESS_SESSION` when the current runtime is `headless`.
- For destructive writes, inspect tool help first and require explicit user intent.
- Use `--url` only for the site the user asked for. Do not silently redirect hosts.

## References

- Common creation and invocation patterns:
  - `references/usage-patterns.md`
- Source mode selection and argument mapping:
  - `references/source-modes.md`
- Link patterns, naming, and profile layout:
  - `references/link-patterns.md`
- Common failures and recovery steps:
  - `references/troubleshooting.md`
- Concrete creation script:
  - `scripts/ensure-links.sh`
