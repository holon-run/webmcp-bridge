---
name: webmcp-bridge
description: Connect a website to the local-mcp browser bridge through fixed UXC links. Use when the user needs to operate native WebMCP sites or adapter-backed sites through local-mcp, manage per-site browser profiles, or switch between headless and UI bridge modes.
---

# WebMCP Bridge

Use this skill to operate `@webmcp-bridge/local-mcp` through `uxc` shortcut commands.

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
3. Create or refresh the fixed link pair for that site:
   - `command -v <site>-webmcp-cli`
   - `command -v <site>-webmcp-ui`
   - if either is missing or the source config changed, run `skills/webmcp-bridge/scripts/ensure-links.sh`
4. Use the CLI link for normal automation:
   - `<site>-webmcp-cli -h`
   - `<site>-webmcp-cli <operation> -h`
   - `<site>-webmcp-cli <operation> field=value`
   - `<site>-webmcp-cli <operation> '{"field":"value"}'`
5. Use the UI link when a human needs to cooperate with the browser session:
   - login or MFA challenge
   - visual confirmation
   - human and AI editing the same page together
6. Parse JSON output only:
   - success path: `.ok == true`, consume `.data`
   - failure path: `.ok == false`, inspect `.error.code` and `.error.message`

## Link Contract

Every site gets two fixed commands:

- `<site>-webmcp-cli`: headless bridge for normal tool calls
- `<site>-webmcp-ui`: headed bridge for login and live collaboration

Both links must share the same site profile and daemon lock:

- profile path: `~/.uxc/webmcp-profile/<site>`
- daemon key: same as profile path

The CLI link should stay deterministic:

- use `--headless`
- use `--no-auto-login-fallback`

The UI link should stay visible:

- use `--no-headless`

## Guardrails

- Prefer browser-side execution for privileged site actions. Do not move site credentials into local scripts.
- Do not share one `--user-data-dir` across multiple unrelated sites.
- Do not dynamically rename link commands at runtime. The skill author chooses the link name once.
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
