# Adapter: Weibo

`@webmcp-bridge/adapter-weibo` supports Weibo when native browser WebMCP is unavailable.

## Key Tool Areas

- timeline and profile reads
- post and comment creation
- article drafting and publishing
- standard search and AI search summary

## Current Weibo Coverage

The adapter currently supports:

- `timeline.home.list`
- `post.get`
- `post.create`
- `post.replies.list`
- `post.repost.list`
- `comment.create`
- `user.get`
- `user.posts.list`
- `search.weibo`
- `search.ai.summary`
- `article.listDrafts`
- `article.getDraft`
- `article.draftMarkdown`
- `article.publishMarkdown`

## Read Behavior

Recent read-path hardening includes:

- long Weibo text hydration when timeline or post payloads are truncated
- normalized openable post URLs using `uid/mblogid` or `uid/number_id`
- image extraction from `pic_infos`
- video extraction from `page_info.media_info`
- mblogid decoding for short-form Weibo URLs

## Write Behavior

Recent write support includes:

- dry-run support for `post.create`, `comment.create`, and `article.publishMarkdown`
- markdown-to-article conversion for article drafts
- article cover image upload through the current Weibo editor flow

## Session Guidance

Weibo is auth-sensitive. Expect bootstrap or attach to be needed on first use of a fresh profile.

See:

- [Bridge Session Model](../reference/session-lifecycle.md)
- [CLI And Control Plane](../reference/cli.md)
