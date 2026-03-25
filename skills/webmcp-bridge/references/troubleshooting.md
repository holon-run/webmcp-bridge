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
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
```

After login, switch back explicitly if needed:

```bash
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headless"}'
```

If `bridge.session.mode.set` returns `UNSUPPORTED_SESSION_CONTROL`, the current session is either external attach or bootstrap-only. Use a headed external browser, or finish attach first.

## Only bridge tools are visible

If `<site>-webmcp-cli -h` only lists `bridge.*`, the stdio bridge is running but the site runtime is not ready yet.

Start with:

```bash
<site>-webmcp-cli bridge.session.status
```

Then choose the next step from the status:

- If auth/bootstrap is incomplete, start or resume bootstrap:

```bash
<site>-webmcp-cli bridge.session.bootstrap
```

Complete login, then rerun:

```bash
<site>-webmcp-cli -h
```

- If the managed profile should already be logged in, attach the session:

```bash
<site>-webmcp-cli bridge.session.attach
```

Then rerun:

```bash
<site>-webmcp-cli -h
```

- If the task requires a visible browser while recovering:

```bash
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
```

Only continue to business tools after help output shows the site operations again.

## The command default says headless but the session is still headed

The launcher only sets the preferred default for bridge-managed sessions. It does not force the current live session to restart.

Check actual runtime state:

```bash
<site>-webmcp-cli bridge.session.status
```

If the current session is managed, switch it explicitly:

```bash
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headless"}'
```

## UI window flashes open and closes immediately

If the window still flashes open and disappears, verify that:

- `uxc` is updated to a recent release
- the `<site>-webmcp-cli` link was recreated after updating `uxc`
- the environment can launch Playwright browsers for the current `HOME`
- `bridge.session.status` reports `presentationMode = headed`
- the current daemon idle TTL policy is not immediately reaping the process after the command returns

Then rerun:

```bash
<site>-webmcp-cli bridge.open
```

If your environment needs a more aggressive keepalive policy for interactive sessions, recreate the link with an explicit daemon TTL override:

```bash
WEBMCP_DAEMON_IDLE_TTL=0 skills/webmcp-bridge/scripts/ensure-links.sh --name <site> ...
```

## The user closed the headed browser window manually

Run the same open command again:

```bash
<site>-webmcp-cli bridge.open
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
<site>-webmcp-cli -h
<site>-webmcp-cli <operation> -h
```

If the page changed meaningfully, refresh the bridge session by invoking the link again.
