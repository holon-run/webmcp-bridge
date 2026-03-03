# Adapter Fixture

`@webmcp-bridge/adapter-fixture` is a deterministic fallback adapter for integration and contract tests.

## Tools

- `fixture.health`: returns adapter status and call counters.
- `fixture.auth_state`: returns current fixture auth state.
- `fixture.set_auth_state`: switches fixture auth state.
- `fixture.echo`: deterministic roundtrip payload tool.
- `fixture.math.add`: deterministic numeric tool.
- `fixture.fail`: deterministic error payload tool.

## Usage

Use with local-mcp site preset:

```bash
node packages/local-mcp/dist/cli.js --site fixture --headless
```

This keeps the full runtime path (`local-mcp -> playwright -> adapter`) while avoiding external site instability.
