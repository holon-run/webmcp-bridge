# Usage Patterns

## URL-backed native site

```bash
command -v board-webmcp-cli
skills/webmcp-bridge/scripts/ensure-links.sh --name board --url https://board.holon.run
board-webmcp-cli -h
board-webmcp-cli nodes.list
```

## Built-in adapter site

```bash
command -v x-webmcp-cli
skills/webmcp-bridge/scripts/ensure-links.sh --name x --site x
x-webmcp-cli bridge.session.status
x-webmcp-cli bridge.session.bootstrap
x-webmcp-cli -h
x-webmcp-cli timeline.home.list -h
```

For auth-sensitive built-in sites such as `x`, expect the first headed run to require manual
sign-in against the managed profile before page tools become available.

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

## Mode switch pattern

```bash
<site>-webmcp-cli bridge.session.mode.get
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
<site>-webmcp-cli <operation>
<site>-webmcp-cli bridge.close
```
