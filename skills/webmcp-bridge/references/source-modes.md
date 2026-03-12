# Source Modes

Pick exactly one primary source mode for each site link.

## URL mode

Use URL mode when the page itself exposes native WebMCP or when you want polyfill-only behavior without an adapter preset.

Examples:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh --name board --url https://board.holon.run
skills/webmcp-bridge/scripts/ensure-links.sh --name board --url http://127.0.0.1:4173
```

Generated local-mcp arguments:

```bash
--url <url>
```

## Built-in adapter mode

Use a built-in site preset when `@webmcp-bridge/local-mcp` already ships the fallback adapter.

Example:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh --name x --site x
```

Generated local-mcp arguments:

```bash
--site <site>
```

## External adapter mode

Use an external adapter module when the fallback implementation is shipped outside the local-mcp package.

Example:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh \
  --name fixture-demo \
  --adapter-module ./examples/adapter-template/dist/index.js
```

Optional URL override example:

```bash
skills/webmcp-bridge/scripts/ensure-links.sh \
  --name custom-site \
  --adapter-module @your-scope/webmcp-adapter \
  --url https://example.com
```

Generated local-mcp arguments:

```bash
--adapter-module <specifier> [--url <url>]
```

## Selection Rules

- If the user gives an exact URL and does not ask for a fallback adapter, start with URL mode.
- If the user asks for a built-in site preset such as `x`, use `--site`.
- If the user provides an npm package, file path, or `file://` URL for an adapter, use `--adapter-module`.
- Do not combine `--site` and `--adapter-module`.
