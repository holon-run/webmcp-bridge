# Adapter: Fixture

`@webmcp-bridge/adapter-fixture` is a deterministic fallback adapter for integration and contract tests.

## Key Tool Areas

- auth-state switching for test scenarios
- deterministic roundtrip payloads
- deterministic math and error paths

## Current Fixture Coverage

The adapter currently supports:

- `auth.get`
- `auth.set`
- `echo.execute`
- `math.add`
- `fail.execute`

## Recommended Use

Use the fixture adapter when you want to verify the full:

- `local-mcp -> playwright -> adapter`

path without depending on external websites or unstable live DOM behavior.

## Session Guidance

The fixture adapter does not require account login or bootstrap recovery.

Typical usage:

```bash
node packages/local-mcp/dist/cli.js --site fixture --headless
```
