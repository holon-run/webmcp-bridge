# Adapter X

`@webmcp-bridge/adapter-x` provides the real fallback adapter for X/Twitter flows when a page does not expose native `navigator.modelContext`.

## Tools

- `auth.get`: detect `authenticated`, `auth_required`, or `challenge_required`.
- `timeline.home.list`: read home timeline tweet cards.
- `timeline.user.list`: read a specific user's timeline tweet cards.
- `search.tweets.list`: read search result tweet cards.
- `tweet.get`: read one tweet by URL or ID.
- `favorites.list`: read bookmarks/favorites tweet cards.
- `user.get`: read a user profile summary by handle.
- `tweet.create`: submit a text post with optional `dryRun`.

`timeline.home.list`, `timeline.user.list`, `search.tweets.list`, and `favorites.list` support incremental pagination with:

- input: `limit`, optional `cursor`
- output: `items`, `source` (`network` or `dom`), `hasMore`, optional `nextCursor`
- when `source=dom`, `debug.reason` explains fallback cause (for example `no_template`, `http_error_403`, `empty_result`)

`search.tweets.list` input:

- `query` (required)
- `mode` (optional, `latest` by default, allowed `top | latest`)
- `limit`, `cursor` (optional)

## Behavior

- Auth gating is fail-closed:
  - returns `AUTH_REQUIRED` when session is not logged in;
  - returns `CHALLENGE_REQUIRED` when challenge/verification UI is detected.
- Compose is confirmation-based:
  - submit is not treated as success until timeline confirmation succeeds;
  - returns `ACTION_UNCONFIRMED` if confirmation times out.
- Error payloads are stable JSON with `error.code` and `error.message`.
- Read-only pages are reused across calls (`home`, `bookmarks`, `user:<username>`, `search:<query>:<mode>`) to improve template capture stability.
- Network template capture hooks both `fetch` and `XMLHttpRequest`, with a lightweight warmup (scroll/reload) before fallback.
- Template metadata is cached at process scope (`home` / `bookmarks` / `tweet` / `user_timeline` / `search`) and reused when current-page capture is temporarily unavailable.

## MCP call examples

Home timeline first page:

```json
{
  "method": "tools/call",
  "params": {
    "name": "timeline.home.list",
    "arguments": { "limit": 10 }
  }
}
```

Home timeline next page:

```json
{
  "method": "tools/call",
  "params": {
    "name": "timeline.home.list",
    "arguments": { "limit": 10, "cursor": "<nextCursor>" }
  }
}
```

User timeline:

```json
{
  "method": "tools/call",
  "params": {
    "name": "timeline.user.list",
    "arguments": { "username": "jack", "limit": 10 }
  }
}
```

Search tweets:

```json
{
  "method": "tools/call",
  "params": {
    "name": "search.tweets.list",
    "arguments": { "query": "playwright", "mode": "latest", "limit": 10 }
  }
}
```

## Known limits

- Selector-based implementation; upstream UI changes may require selector updates.
- Text-only compose scope in `0.1.x`.
- Requires user already logged in on web session.
