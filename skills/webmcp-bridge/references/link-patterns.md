# Link Patterns

Use a fixed naming scheme so humans and agents can predict the command names.

## Link Names

For site name `<site>`:

- CLI link: `<site>-webmcp-cli`
- UI link: `<site>-webmcp-ui`

Examples:

- `board-webmcp-cli`
- `board-webmcp-ui`
- `x-webmcp-cli`
- `x-webmcp-ui`

## Profile Layout

Use one profile directory per site:

```bash
~/.uxc/webmcp-profile/<site>
```

Examples:

```bash
~/.uxc/webmcp-profile/board
~/.uxc/webmcp-profile/x
```

CLI and UI links for the same site must share the same profile path and the same `--daemon-exclusive` key.

## Link Creation Pattern

```bash
command -v <site>-webmcp-cli
command -v <site>-webmcp-ui
skills/webmcp-bridge/scripts/ensure-links.sh --name <site> --url <url>
<site>-webmcp-cli -h
<site>-webmcp-cli <operation> -h
```

## Invocation Pattern

Prefer `key=value` for simple inputs:

```bash
<site>-webmcp-cli <operation> field=value
```

For nested payloads, use one positional JSON object:

```bash
<site>-webmcp-cli <operation> '{"field":"value"}'
```
