# Testing

Adapters need both contract tests and full bridge tests.

## Contract Coverage

At the adapter package level, test:

- manifest validity
- tool list shape
- validation errors for malformed inputs
- stable success payload shape
- stable error payload shape

## Integration Coverage

At the bridge level, test:

- `tools/list` through `local-mcp`
- `tools/call` through `local-mcp`
- native-first fallback behavior when native WebMCP is absent
- adapter startup and teardown behavior when relevant

## Read Path Expectations

For paginated read tools, verify:

- first page without `cursor`
- follow-up page with `cursor`
- `items`, `hasMore`, and `nextCursor`
- `source` and `reason` when DOM fallback happens

## Real Site Safety

For real authenticated sites:

- prefer read-only smoke coverage in CI or local verification
- keep destructive writes behind explicit user intent
- do not hard-code secrets in tests
