# Usage Patterns

Prefer the published docs for the current command surface:

- CLI reference:
  - `https://webmcp-bridge.holon.run/reference/cli`
- Session lifecycle:
  - `https://webmcp-bridge.holon.run/reference/session-lifecycle`

Search before guessing:

```bash
curl 'https://webmcp-bridge.holon.run/api/search?q=bridge.session.attach'
curl 'https://webmcp-bridge.holon.run/api/search?q=overlay-bootstrap'
curl 'https://webmcp-bridge.holon.run/api/search?q=bridge.overlay.export'
```

Minimal local flow:

```bash
command -v <site>-webmcp-cli
<site>-webmcp-cli -h
<site>-webmcp-cli <operation> -h
<site>-webmcp-cli <operation> field=value
<site>-webmcp-cli <operation> '{"field":"value"}'
```
