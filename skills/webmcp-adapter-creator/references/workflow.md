# Workflow

## 1. Check whether an adapter is needed

Before writing adapter code, verify whether the site already exposes native WebMCP.

If native WebMCP exists:

- stop adapter work
- use `$webmcp-bridge`
- create site wrapper skills only if they improve UX

If native WebMCP does not exist:

- continue with fallback adapter creation

## 2. Scaffold the package

Use the helper script to create a starting package from `examples/adapter-template`:

```bash
skills/webmcp-adapter-creator/scripts/scaffold-adapter.sh \
  --name <site> \
  --host <host> \
  --url <url>
```

Default output path:

```bash
packages/adapter-<site>
```

## 3. Define the tool contract first

Start from user-facing capabilities, not implementation details.

Preferred naming examples:

- `tweet.get`
- `timeline.home.list`
- `timeline.user.list`
- `user.get`
- `favorites.list`
- `search.tweets.list`

For each tool:

- add a stable description
- add field-level schema descriptions
- keep inputs small and predictable
- use pagination shape consistently: `limit`, optional `cursor` -> `items`, `hasMore`, optional `nextCursor`

## 4. Implement browser-side execution

Adapters should use the Playwright page as the privileged runtime.

Preferred order:

1. page-context network/template execution
2. DOM fallback only when network/template execution is unavailable or insufficient

## 5. Add error mapping

Map raw failures into stable adapter errors:

- `AUTH_REQUIRED`
- `CHALLENGE_REQUIRED`
- `UPSTREAM_CHANGED`
- `VALIDATION_ERROR`
- `TOOL_NOT_FOUND`

## 6. Test the package

Minimum expectation:

- package `typecheck`
- package `build`
- local tool contract tests
- local-mcp integration path for the adapter source
