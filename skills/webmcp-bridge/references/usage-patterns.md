# Usage Patterns

## URL-backed native site

```bash
command -v board-webmcp-cli
command -v board-webmcp-ui
skills/webmcp-bridge/scripts/ensure-links.sh --name board --url https://board.holon.run
board-webmcp-cli -h
board-webmcp-cli nodes.list
```

## Built-in adapter site

```bash
command -v x-webmcp-cli
command -v x-webmcp-ui
skills/webmcp-bridge/scripts/ensure-links.sh --name x --site x
x-webmcp-cli -h
x-webmcp-cli timeline.home.list -h
```

## Third-party adapter module

```bash
skills/webmcp-bridge/scripts/ensure-links.sh \
  --name custom-site \
  --adapter-module @your-scope/webmcp-adapter \
  --url https://example.com
custom-site-webmcp-cli -h
```

## JSON payload pattern

```bash
<site>-webmcp-cli <operation> field=value
<site>-webmcp-cli <operation> '{"field":"value"}'
```

## UI collaboration pattern

```bash
<site>-webmcp-ui -h
```
