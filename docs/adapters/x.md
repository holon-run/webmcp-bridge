# Adapter X

`@webmcp-bridge/adapter-x` provides the real fallback adapter for X/Twitter flows when a page does not expose native `navigator.modelContext`.

## Local-mcp session model

When X is used through `@webmcp-bridge/local-mcp`, it is treated as an auth-sensitive site.
The recommended startup path is:

1. start `local-mcp` with `--site x --user-data-dir <profile>` in headed mode
2. let `bridge.session.bootstrap` open a normal browser for manual sign-in when needed
3. let local-mcp reattach to the authenticated profile for page automation

Example:

```bash
webmcp-local-mcp --site x --no-headless --user-data-dir ~/.uxc/webmcp-profile/x
```

## Tools

- `auth.get`: detect `authenticated`, `auth_required`, or `challenge_required`.
- `timeline.home.list`: read home timeline tweet cards.
- `timeline.user.list`: read a specific user's timeline tweet cards.
- `search.tweets.list`: read search result tweet cards.
- `tweet.get`: read one tweet by URL or ID.
- `tweet.conversation.get`: read one tweet conversation by URL or ID.
- `tweet.replies.list`: read reply tweets for one focal tweet by URL or ID.
- `tweet.thread.get`: read one tweet thread by URL or ID.
- `tweet.media.download`: download media for one tweet by URL or ID.
- `favorites.list`: read bookmarks/favorites tweet cards.
- `notifications.list`: read the main notifications feed.
- `mentions.list`: read the mentions tab from notifications.
- `user.get`: read a user profile summary by handle.
- `tweet.create`: submit a text post with optional `dryRun`.
- `tweet.reply`: reply to one tweet by URL or ID, with optional `dryRun`.
- `tweet.delete`: delete one tweet by URL or ID, with optional `dryRun`.
- `grok.chat`: send one prompt to Grok, optionally upload local files, and return the assistant reply.
- `article.get`: read one X article by public URL, edit URL, or ID.
- `article.draftMarkdown`: create one X article draft from a local markdown file, with optional cover image.
- `article.publishMarkdown`: publish one X article from a local markdown file, with optional cover image.
- `article.publish`: publish one existing X article draft by edit URL, public URL, or ID.
- `article.setCoverImage`: set or replace the cover image for one existing X article draft.
- `article.updateMarkdown`: replace the title and body of one existing X article draft from a local markdown file.
- `article.delete`: delete one X article draft or published article by edit URL, public URL, or ID.

`timeline.home.list`, `timeline.user.list`, `search.tweets.list`, and `favorites.list` support incremental pagination with:

- input: `limit`, optional `cursor`
- output: `items`, `source` (`network` or `dom`), `hasMore`, optional `nextCursor`
- when `source=dom`, `debug.reason` explains fallback cause (for example `no_template`, `http_error_403`, `empty_result`)

`notifications.list` and `mentions.list` currently expose:

- input: `limit`
- output: `items`, `source=dom`, `hasMore=false`

`tweet.get`, `tweet.conversation.get`, `tweet.replies.list`, and `tweet.thread.get` may include:

- `media`: zero or more media entries
- each media entry includes `type`, `url`, and optional `previewUrl`, `width`, `height`, `durationMs`, `variants`

`tweet.conversation.get` and `tweet.replies.list` expose:

- input: `url | id`, `limit`, optional `cursor`
- `tweet.conversation.get` output: `focal`, `ancestors`, `replies`, `source`, `hasMore`, optional `nextCursor`
- `tweet.replies.list` output: `focal`, `items`, `source`, `hasMore`, optional `nextCursor`

`tweet.thread.get` exposes:

- input: `url | id`, `limit`
- output: `root`, `focal`, `tweets`, `source`, optional `incomplete`, optional `nextCursor`

`tweet.delete` exposes:

- input: `url | id`, optional `dryRun`
- output: `ok`, optional `dryRun`, optional `deleteVisible`, optional `confirmed`, optional `tweetId`, optional `url`

`tweet.media.download` exposes:

- input: `url | id`, optional `mediaIndex`
- output: `tweet`, `items`
- each `items[]` entry includes `mediaIndex`, `media`, `artifact`
- each `artifact` includes `path`, `name`, `mimeType`, `mediaIndex`, `sourceUrl`
- `artifact.path` is a local temporary file path created by the adapter on the current machine

`article.draftMarkdown` exposes:

- input: `markdownPath`, optional `title`, optional `coverImagePath`
- `markdownPath` and `coverImagePath` are local absolute file paths
- the adapter derives the title from the first markdown heading when `title` is omitted
- markdown image syntax with local file paths is supported; local inline images are uploaded through the article editor
- output: `ok`, `title`, `editUrl`, optional `articleId`, `inlineImageCount`, `hasCoverImage`, `persisted`, `sessionScoped`
- when `persisted=false`, the draft is only guaranteed to be publishable or deletable within the current bridge session; call `article.publish` or `article.delete` before the session is discarded

`article.get` exposes:

- input: `url | id`
- when `id` is provided without `url`, the adapter opens the article editor URL for the authenticated account
- output: `article`
- `article` may include `id`, `title`, `text`, `url`, `editUrl`, `coverImageUrl`, `images`, `authorName`, `authorHandle`, `source`, `published`, optional `sessionScoped`
- `source=editor` means the adapter read the authenticated editor view; `source=public` means it read a public article page

`article.publishMarkdown` exposes:

- input: `markdownPath`, optional `title`, optional `coverImagePath`, optional `dryRun`
- `markdownPath` and `coverImagePath` are local absolute file paths
- the adapter derives the title from the first markdown heading when `title` is omitted
- markdown image syntax with local file paths is supported; local inline images are uploaded through the article editor
- output: `ok`, optional `dryRun`, optional `confirmed`, `title`, `editUrl`, optional `articleId`, optional `articleUrl`, `inlineImageCount`, `hasCoverImage`, `persisted`, `sessionScoped`

`article.publish` exposes:

- input: `url | id`
- output: `ok`, `confirmed`, `editUrl`, optional `articleId`, optional `articleUrl`
- when publishing a session-scoped draft, call it in the same bridge session that created the draft

`article.setCoverImage` exposes:

- input: `url | id`, `coverImagePath`
- `coverImagePath` is a local absolute file path
- output: `ok`, `editUrl`, optional `articleId`, `hasCoverImage`, optional `sessionScoped`

`article.updateMarkdown` exposes:

- input: `url | id`, `markdownPath`, optional `title`
- `markdownPath` is a local absolute file path
- markdown image syntax with local file paths is supported; local inline images are uploaded through the article editor
- output: `ok`, `title`, `editUrl`, optional `articleId`, `inlineImageCount`, optional `persisted`, optional `sessionScoped`

`article.delete` exposes:

- input: `url | id`, optional `dryRun`
- output: `ok`, optional `dryRun`, optional `deleteVisible` (in dry-run mode), optional `confirmed`

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

Read a tweet conversation:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tweet.conversation.get",
    "arguments": { "id": "2033895522382319922", "limit": 10 }
  }
}
```

List replies for a tweet:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tweet.replies.list",
    "arguments": { "id": "2033895522382319922", "limit": 10 }
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

Download tweet media:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tweet.media.download",
    "arguments": { "id": "1628605836938604544" }
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

Delete a tweet:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tweet.delete",
    "arguments": {
      "id": "1234567890123456789"
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
      "attachmentPaths": ["/tmp/grok-upload-sample.csv"]
    }
  }
}
```

Create one article draft from markdown:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.draftMarkdown",
    "arguments": {
      "markdownPath": "/tmp/post.md",
      "coverImagePath": "/tmp/cover.png"
    }
  }
}
```

Read one article:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.get",
    "arguments": {
      "id": "2035000000000000000"
    }
  }
}
```

Publish one article from markdown:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.publishMarkdown",
    "arguments": {
      "markdownPath": "/tmp/post.md",
      "coverImagePath": "/tmp/cover.png"
    }
  }
}
```

Publish one draft article:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.publish",
    "arguments": {
      "id": "2035000000000000000"
    }
  }
}
```

Set one draft cover image:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.setCoverImage",
    "arguments": {
      "id": "2035000000000000000",
      "coverImagePath": "/tmp/cover.png"
    }
  }
}
```

Update one draft from markdown:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.updateMarkdown",
    "arguments": {
      "id": "2035000000000000000",
      "markdownPath": "/tmp/post.md"
    }
  }
}
```

Delete one article:

```json
{
  "method": "tools/call",
  "params": {
    "name": "article.delete",
    "arguments": {
      "id": "2035000000000000000"
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
- `tweet.conversation.get` models the detail-page conversation view; `tweet.thread.get` derives the same-author thread chain from that conversation instead of returning the full reply tree.
- `tweet.media.download` currently materializes media into local temp paths and returns artifact metadata; it does not yet integrate with native browser download events.
- `tweet.media.download` only fetches `https` media from expected X media hosts (`pbs.twimg.com`, `video.twimg.com`).
- Text-only compose and reply scope in `0.1.x`.
- `article.draftMarkdown`, `article.publishMarkdown`, and `article.publish` currently rely on X article editor selectors and markdown paste behavior; if X changes the editor, selector updates may be required.
- `grok.chat` starts a new conversation by default; pass `conversationId` to continue an existing chat.
- `grok.chat` attachments currently support local file-path uploads only, via `attachmentPaths`.
- `grok.chat` marks each `attachmentPaths` item with `x-uxc-kind: "file-path"` so schema-aware clients can treat them as local file references.
- Download artifacts are currently extracted from Grok `data:` links and materialized to a local temp path; native browser download capture is not wired yet.
- `notifications.list` and `mentions.list` are currently DOM-backed and do not expose cursor pagination yet.
- Requires user already logged in on web session.
