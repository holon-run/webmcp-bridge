# Adapter Weibo

`@webmcp-bridge/adapter-weibo` provides the fallback adapter for Weibo when a page does not expose native `navigator.modelContext`.

## Local-mcp session model

Weibo is treated as an auth-sensitive site in `@webmcp-bridge/local-mcp`.
The recommended startup path is:

1. start `local-mcp` with `--site weibo --user-data-dir <profile>` in headed mode
2. let `bridge.session.bootstrap` open a normal browser for manual sign-in when needed
3. let local-mcp reattach to the authenticated profile for page automation

Example:

```bash
webmcp-local-mcp --site weibo --no-headless --user-data-dir ~/.uxc/webmcp-profile/weibo
```

To attach to an already running Chromium browser instead of launching a managed one:

```bash
webmcp-local-mcp --site weibo --browser-url http://127.0.0.1:9222
```

## Tools

- `auth.get`: detect `authenticated`, `auth_required`, or `challenge_required`.
- `page.get`: return the current page URL and title for debugging.
- `timeline.home.list`: read the home feed. Network mode uses Weibo `max_id` cursors; DOM fallback also accepts `dom:<offset>`.
- `post.get`: read one post by URL or ID.
- `post.replies.list`: read replies/comments for one post. Network mode uses Weibo `max_id` cursors.
- `post.repost.list`: read reposts for one post. Current network mode uses page-number cursors such as `2` or `3`.
- `user.get`: read one user profile by URL or `screenName`.
- `user.posts.list`: read one user's posts. Current network mode uses page-number cursors such as `2` or `3`.
- `search.weibo`: read standard Weibo search results from `s.weibo.com/weibo`.
- `search.ai.summary`: read AI search summary content from `s.weibo.com/aisearch` and `ai.s.weibo.com`.

## Behavior

- Auth gating is fail-closed:
  - returns `AUTH_REQUIRED` when session is not logged in
  - returns `CHALLENGE_REQUIRED` when verification UI is detected
- `timeline.home.list`, `post.get`, `post.replies.list`, `post.repost.list`, `user.get`, and `user.posts.list` are network-first and fall back to DOM extraction when template replay or in-page fetch fails.
- `search.weibo` is DOM-first because the current Weibo search results page is server-rendered and paginates through full HTML navigations.
- `search.ai.summary` uses the AI search API directly and falls back to DOM extraction on the `aisearch` page.
- `search.ai.summary` may return metadata without `summary` text when the AI endpoint responds successfully but does not provide a rendered summary body; this is reported as `reason = "summary_unavailable"`.
- Read responses use `source = "network"` or `source = "dom"`.
- When fallback or degraded execution happens, `reason` explains why, for example `no_template`, `request_failed`, or `http_error_403`.

## Search notes

Current Weibo search behavior is split into two product lines:

- standard search:
  - URL: `https://s.weibo.com/weibo?q=<query>`
  - main results are server-rendered HTML
  - pagination is full-page navigation through `page=<n>`

- AI search:
  - URL: `https://s.weibo.com/aisearch?q=<query>`
  - summary content comes from `https://ai.s.weibo.com/api/llm/analysis_demo_result.json`
  - the endpoint can return structured metadata without a non-empty `msg`, depending on query and current experiment state

The adapter intentionally exposes these as two tools:

- `search.weibo`
- `search.ai.summary`

There is currently no separate `search.ai.related.list` because a stable browser-visible batch-detail interface for AI-related posts has not been confirmed.

## MCP call examples

Read the first page of the home timeline:

```json
{
  "method": "tools/call",
  "params": {
    "name": "timeline.home.list",
    "arguments": { "limit": 10 }
  }
}
```

Read the next page of the home timeline:

```json
{
  "method": "tools/call",
  "params": {
    "name": "timeline.home.list",
    "arguments": { "limit": 10, "cursor": "<nextCursor>" }
  }
}
```

Read one post:

```json
{
  "method": "tools/call",
  "params": {
    "name": "post.get",
    "arguments": { "id": "5279584255214211" }
  }
}
```

Read comments for one post:

```json
{
  "method": "tools/call",
  "params": {
    "name": "post.replies.list",
    "arguments": { "id": "5279584255214211" }
  }
}
```

Read reposts for one post:

```json
{
  "method": "tools/call",
  "params": {
    "name": "post.repost.list",
    "arguments": { "id": "5279584255214211", "cursor": "2" }
  }
}
```

Read one user profile:

```json
{
  "method": "tools/call",
  "params": {
    "name": "user.get",
    "arguments": { "screenName": "jolestar" }
  }
}
```

Read one user's posts:

```json
{
  "method": "tools/call",
  "params": {
    "name": "user.posts.list",
    "arguments": { "uid": "1648815335", "cursor": "2" }
  }
}
```

Run standard search:

```json
{
  "method": "tools/call",
  "params": {
    "name": "search.weibo",
    "arguments": { "query": "OpenAI", "limit": 10 }
  }
}
```

Read AI search summary:

```json
{
  "method": "tools/call",
  "params": {
    "name": "search.ai.summary",
    "arguments": { "query": "OpenAI" }
  }
}
```

## Manual regression

Recommended smoke checks after signing in on a bootstrap browser:

1. `auth.get`
2. `timeline.home.list`
3. `post.get`
4. `post.replies.list`
5. `user.get`
6. `user.posts.list`
7. `search.weibo`
8. `search.ai.summary`

Repeatable browser-attached smoke script:

```bash
pnpm --filter @webmcp-bridge/adapter-weibo exec node scripts/weibo-smoke.mjs
```

Optional overrides:

- `BROWSER_URL`
- `WEIBO_QUERY`
- `WEIBO_UID`
- `WEIBO_POST_ID`
- `WEIBO_POST_AUTHOR_UID`

Repeatable `local-mcp -> bridge -> browser` live smoke:

```bash
RUN_WEIBO_LIVE=1 \
WEIBO_BROWSER_URL=http://127.0.0.1:9222 \
WEIBO_USER_DATA_DIR=/tmp/webmcp-weibo-bootstrap \
WEIBO_UID=1648815335 \
pnpm vitest run packages/local-mcp/test/live-weibo-smoke.test.ts
```

This live test is skipped by default and verifies:

1. MCP `initialize`
2. `tools/list`
3. `auth.get`
4. `timeline.home.list`
5. `search.weibo`
6. `post.get`
7. `user.get`
8. `user.posts.list`
9. `search.ai.summary`

If Weibo changes request shape or login behavior, prefer re-capturing real browser requests in an attached bootstrap browser instead of guessing new API shapes from DOM alone.
