# Troubleshooting

Canonical docs:

- Session lifecycle:
  - `https://webmcp-bridge.holon.run/reference/session-lifecycle`
- CLI reference:
  - `https://webmcp-bridge.holon.run/reference/cli`

Search current behavior before guessing:

```bash
curl 'https://webmcp-bridge.holon.run/api/search?q=overlay-bootstrap'
curl 'https://webmcp-bridge.holon.run/api/search?q=bridge.session.bootstrap'
curl 'https://webmcp-bridge.holon.run/api/search?q=bridge.overlay.export'
```

Minimal recovery ladder:

```bash
<site>-webmcp-cli bridge.session.status
<site>-webmcp-cli bridge.session.attach
<site>-webmcp-cli bridge.session.bootstrap
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
```

For adapterless pages in `overlay-bootstrap`, prefer:

```bash
<site>-webmcp-cli bridge.debug.eval '{"script":"() => document.title"}'
<site>-webmcp-cli bridge.overlay.install '{"id":"draft","tools":[{"name":"page.title.get","script":"() => ({ title: document.title })"}]}'
```

If it still looks like a real bridge or adapter bug after checking the docs search, open an issue:

- `https://github.com/holon-run/webmcp-bridge/issues`
