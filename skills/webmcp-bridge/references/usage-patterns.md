# Usage Patterns

## URL-backed native site

```bash
command -v board-webmcp
skills/webmcp-bridge/scripts/ensure-links.sh --name board --url https://board.holon.run
board-webmcp -h
board-webmcp nodes.list
```

## Built-in adapter site

```bash
command -v x-webmcp
skills/webmcp-bridge/scripts/ensure-links.sh --name x --site x
x-webmcp bridge.session.status
x-webmcp bridge.session.bootstrap
x-webmcp -h
x-webmcp timeline.home.list -h
```

For auth-sensitive built-in sites such as `x`, expect the first headed run to require manual
sign-in against the managed profile before page tools become available.

## Third-party adapter module

```bash
skills/webmcp-bridge/scripts/ensure-links.sh \
  --name custom-site \
  --adapter-module @your-scope/webmcp-adapter \
  --url https://example.com
custom-site-webmcp -h
```

## JSON payload pattern

```bash
<site>-webmcp <operation> field=value
<site>-webmcp <operation> '{"field":"value"}'
```

## Mode switch pattern

```bash
<site>-webmcp bridge.session.mode.get
<site>-webmcp bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp bridge.open
<site>-webmcp <operation>
<site>-webmcp bridge.close
```
