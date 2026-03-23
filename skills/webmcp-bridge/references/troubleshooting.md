# Troubleshooting

## Link exists but points to old config

Recreate the link with `--force` through the helper script:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh --name <site> ...
```

The script always refreshes the fixed site link.

## Headless flow cannot authenticate

Switch the managed session to `headed`, then open the visible window:

```bash
<site>-webmcp bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp bridge.open
```

After login, switch back explicitly if needed:

```bash
<site>-webmcp bridge.session.mode.set '{"mode":"headless"}'
```

If `bridge.session.mode.set` returns `UNSUPPORTED_SESSION_CONTROL`, the current session is either external attach or bootstrap-only. Use a headed external browser, or finish attach first.

## The command default says headless but the session is still headed

The launcher only sets the preferred default for bridge-managed sessions. It does not force the current live session to restart.

Check actual runtime state:

```bash
<site>-webmcp bridge.session.status
```

If the current session is managed, switch it explicitly:

```bash
<site>-webmcp bridge.session.mode.set '{"mode":"headless"}'
```

## UI window flashes open and closes immediately

With current `uxc` and `@webmcp-bridge/local-mcp` releases, `bridge.open` should keep the headed session alive after the command returns.

If the window still flashes open and disappears, verify that:

- `uxc` is updated to a release that includes daemon detach and per-session idle TTL support
- the `<site>-webmcp` link was recreated after updating `uxc`
- the environment can launch Playwright browsers for the current `HOME`
- `bridge.session.status` reports `presentationMode = headed`

Then rerun:

```bash
<site>-webmcp bridge.open
```

## The user closed the headed browser window manually

Run the same open command again:

```bash
<site>-webmcp bridge.open
```

Closing the last headed browser window ends that owner session. The next `bridge.open` starts a new headed session on the same profile, without requiring a daemon reset.

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
<site>-webmcp -h
<site>-webmcp <operation> -h
```

If the page changed meaningfully, refresh the bridge session by invoking the link again.
