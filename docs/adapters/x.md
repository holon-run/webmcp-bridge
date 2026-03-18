# Adapter X

`@webmcp-bridge/adapter-x` provides the real fallback adapter for X/Twitter flows when a page does not expose native `navigator.modelContext`.

## Tools

- `auth.get`: detect `authenticated`, `auth_required`, or `challenge_required`.
- `timeline.home.list`: read home timeline tweet cards.
- `timeline.user.list`: read a specific user's timeline tweet cards.
- `search.tweets.list`: read search result tweet cards.
- `tweet.get`: read one tweet by URL or ID.
- `tweet.thread.get`: read one tweet thread by URL or ID.
- `favorites.list`: read bookmarks/favorites tweet cards.
- `notifications.list`: read the main notifications feed.
- `mentions.list`: read the mentions tab from notifications.
- `user.get`: read a user profile summary by handle.
- `tweet.create`: submit a text post with optional `dryRun`.
- `tweet.reply`: reply to one tweet by URL or ID, with optional `dryRun`.
- `grok.chat`: send one prompt to Grok, optionally upload local files, and return the assistant reply.

`timeline.home.list`, `timeline.user.list`, `search.tweets.list`, and `favorites.list` support incremental pagination with:

- input: `limit`, optional `cursor`
- output: `items`, `source` (`network` or `dom`), `hasMore`, optional `nextCursor`
- when `source=dom`, `debug.reason` explains fallback cause (for example `no_template`, `http_error_403`, `empty_result`)

`notifications.list` and `mentions.list` currently expose:

- input: `limit`
- output: `items`, `source=dom`, `hasMore=false`

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

Read a tweet thread:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tweet.thread.get",
    "arguments": { "id": "2033895522382319922", "limit": 10 }
  }
}
```

List notifications:

```json
{
  "method": "tools/call",
  "params": {
    "name": "notifications.list",
    "arguments": { "limit": 10 }
  }
}
```

List mentions:

```json
{
  "method": "tools/call",
  "params": {
    "name": "mentions.list",
    "arguments": { "limit": 10 }
  }
}
```

Reply to a tweet:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tweet.reply",
    "arguments": {
      "url": "https://x.com/jack/status/20",
      "text": "Thanks, this is useful."
    }
  }
}
```

Chat with Grok:

```json
{
  "method": "tools/call",
  "params": {
    "name": "grok.chat",
    "arguments": { "prompt": "Summarize the latest replies to my last post." }
  }
}
```

Continue an existing Grok conversation:

```json
{
  "method": "tools/call",
  "params": {
    "name": "grok.chat",
    "arguments": {
      "prompt": "Continue from the previous answer in one sentence.",
      "conversationId": "2034141763959722111"
    }
  }
}
```

Chat with Grok and upload one local file:

```json
{
  "method": "tools/call",
  "params": {
    "name": "grok.chat",
    "arguments": {
      "prompt": "Read the attached CSV and give me the total.",
      "attachments": [
        {
          "source": {
            "kind": "file",
            "path": "/tmp/grok-upload-sample.csv"
          }
        }
      ]
    }
  }
}
```

When Grok returns a downloadable `data:` link, `grok.chat` materializes it into a local artifact path:

```json
{
  "ok": true,
  "response": "Download sample.csv DONE",
  "conversationId": "2034214461893214237",
  "url": "https://x.com/i/grok?conversation=2034214461893214237",
  "artifacts": [
    {
      "kind": "file",
      "name": "sample.csv",
      "mimeType": "text/csv",
      "path": "/tmp/webmcp-bridge-grok-abc123/sample.csv"
    }
  ]
}
```

## Known limits

- Selector-based implementation; upstream UI changes may require selector updates.
- Text-only compose and reply scope in `0.1.x`.
- `grok.chat` starts a new conversation by default; pass `conversationId` to continue an existing chat.
- `grok.chat` attachments currently support local file-path uploads only.
- Download artifacts are currently extracted from Grok `data:` links and materialized to a local temp path; native browser download capture is not wired yet.
- `notifications.list` and `mentions.list` are currently DOM-backed and do not expose cursor pagination yet.
- Requires user already logged in on web session.
