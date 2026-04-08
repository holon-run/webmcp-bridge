# Link Patterns

Canonical docs:

- CLI reference:
  - `https://webmcp-bridge.holon.run/reference/cli`

Keep local links predictable:

- command name: `<site>-webmcp-cli`
- profile path: `~/.uxc/webmcp-profile/<site>`

Minimal creation pattern:

```bash
command -v <site>-webmcp-cli
skills/webmcp-bridge/scripts/ensure-links.sh --name <site> --url <url>
<site>-webmcp-cli -h
<site>-webmcp-cli <operation> -h
```
