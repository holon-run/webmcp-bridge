# Troubleshooting

## Link exists but points to old config

Recreate both links with `--force` through the helper script:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh --name <site> ...
```

The script always refreshes both links.

## Headless flow cannot authenticate

Use the UI link so the user can log in directly in the visible browser session:

```bash
<site>-webmcp-ui bridge.open
```

After login, switch back to the CLI link for normal automation.

## UI window flashes open and closes immediately

This usually means the current execution environment did not keep the `uxc` stdio MCP session alive after the command returned.

Use the same command in the user's own interactive terminal instead:

```bash
<site>-webmcp-ui bridge.open
```

Once that headed session stays open, subsequent `<site>-webmcp-ui <tool>` calls can reuse it.

## Fresh machine or isolated HOME cannot start Chromium

If `local-mcp` fails with an error that the Playwright browser executable does not exist, the current environment does not have Playwright browsers installed yet.

Install them once in that environment:

```bash
npx playwright install
```

This most commonly happens when:

- the machine is new
- the process is running under a temporary or isolated `HOME`
- browser caches were manually removed

## Multiple sites interfere with each other

This usually means the same profile directory was reused across sites. Move back to one profile per site:

```bash
~/.uxc/webmcp-profile/<site>
```

## A tool is missing after page navigation

Re-run tool help after the page stabilizes:

```bash
<site>-webmcp-cli -h
<site>-webmcp-cli <operation> -h
```

If the page changed meaningfully, refresh the bridge session by invoking the link again.
