# Link Patterns

Use a fixed naming scheme so humans and agents can predict the command names.

## Link Names

For site name `<site>`:

- Link: `<site>-webmcp-cli`

Examples:

- `board-webmcp-cli`
- `x-webmcp-cli`

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

For auth-sensitive sites such as `x` and `google`, the shared profile is also the anchor for
`bridge.session.bootstrap` and later attach-mode reuse. Do not omit `--user-data-dir` for those sites.

## Link Creation Pattern

```bash
command -v <site>-webmcp-cli
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

When mode matters, inspect and switch it explicitly:

```bash
<site>-webmcp-cli bridge.session.mode.get
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
```
