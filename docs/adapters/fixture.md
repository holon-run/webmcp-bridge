# Adapter Fixture

`@webmcp-bridge/adapter-fixture` is a deterministic fallback adapter for integration and contract tests.

## Tools

- `auth.get`: returns current fixture auth state.
- `auth.set`: switches fixture auth state.
- `echo.execute`: deterministic roundtrip payload tool.
- `math.add`: deterministic numeric tool.
- `fail.execute`: deterministic error payload tool.

## Usage

Use with local-mcp site preset:

```bash
node packages/local-mcp/dist/cli.js --site fixture --headless
```

This keeps the full runtime path (`local-mcp -> playwright -> adapter`) while avoiding external site instability.
