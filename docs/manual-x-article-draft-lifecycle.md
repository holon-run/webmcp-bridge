# X Article Draft Lifecycle Manual Test

This document records the manual regression flow used for issue #35:

- create an X article draft from markdown
- add a cover image
- read the draft back by id
- list drafts and confirm metadata
- read the same draft by preview URL
- update the draft body in place
- read it back again and clean up

## Preconditions

- Local worktree is built:
  - `pnpm --filter @webmcp-bridge/adapter-x build`
  - `pnpm --filter @webmcp-bridge/local-mcp build`
- X login is already valid in:
  - `~/.uxc/webmcp-profile/x`
- Use the adapter-backed compose endpoint so X stays in `adapter-shim` mode:

```bash
export ISSUE35_ENDPOINT="node /private/tmp/webmcp-bridge-issue35/packages/local-mcp/dist/cli.js \
  --adapter-module /private/tmp/webmcp-bridge-issue35/packages/adapter-x/dist/index.js \
  --url https://x.com/compose/articles \
  --headless \
  --no-auto-login-fallback \
  --user-data-dir /Users/jolestar/.uxc/webmcp-profile/x \
  --service-version issue35-v6"
```

## Test Inputs

- Markdown create file:
  - `/tmp/issue35-x-fresh2.7ZlzTZ/post.md`
- Markdown update file:
  - `/tmp/issue35-x-fresh2.7ZlzTZ/post-updated.md`
- Cover image:
  - `/Users/jolestar/.uxc/daemon/blog-public-nav.png`

## Expected Behavior

1. `article.draftMarkdown` creates one draft and returns `draftId`, `editUrl`, and `previewUrl` even when the draft is still unpublished.
2. `article.setCoverImage` confirms the cover is actually applied before returning success.
3. `article.getDraft` returns the same draft by id, including `hasCoverImage`, `editUrl`, and `previewUrl`.
4. `article.listDrafts` includes the draft with stable metadata.
5. `article.get` resolves a draft preview URL through the editor flow.
6. `article.upsertDraftMarkdown` updates the existing draft instead of creating a duplicate.
7. H1 normalization keeps the X article title singular and removes duplicate body H1 content.

## Manual Run

### 1. Create the draft

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.draftMarkdown \
  '{"markdownPath":"/tmp/issue35-x-fresh2.7ZlzTZ/post.md"}'
```

Observed result:

- `draftId`: `2036666046220791808`
- `editUrl`: `https://x.com/compose/articles/edit/2036666046220791808`
- `previewUrl`: `https://x.com/i/articles/2036666046220791808/preview`
- `persisted`: `false`
- `sessionScoped`: `true`

### 2. Add a cover image

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.setCoverImage \
  '{"id":"2036666046220791808","coverImagePath":"/Users/jolestar/.uxc/daemon/blog-public-nav.png"}'
```

Observed result:

- `ok: true`
- `hasCoverImage: true`

### 3. Read the draft by id

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.getDraft \
  '{"id":"2036666046220791808"}'
```

Observed result:

- `title`: `Issue 35 fresh flow v6`
- `hasCoverImage: true`
- `coverImageUrl`: `https://pbs.twimg.com/media/HEOxQWvboAAhCMs.jpg`
- `previewUrl`: `https://x.com/i/articles/2036666046220791808/preview`

### 4. Confirm the draft appears in list results

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.listDrafts '{}'
```

Observed result:

- draft `2036666046220791808` is present
- `hasCoverImage: true`
- `previewUrl` and `editUrl` match the create response

### 5. Read the same draft by preview URL

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.get \
  '{"url":"https://x.com/i/articles/2036666046220791808/preview"}'
```

Observed result:

- `published: false`
- `source: "editor"`
- draft content resolves through preview URL readback

### 6. Update the existing draft in place

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.upsertDraftMarkdown \
  '{"id":"2036666046220791808","markdownPath":"/tmp/issue35-x-fresh2.7ZlzTZ/post-updated.md"}'
```

Observed result:

- returned the same `draftId`
- no duplicate draft was created
- `previewUrl` stayed stable

### 7. Read back after update

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.getDraft \
  '{"id":"2036666046220791808"}'
```

Observed result:

- `title`: `Issue 35 fresh flow v6`
- `text` includes:
  - `Fresh draft update path after cover.`
  - `Fresh section updated`
  - `updated once`
  - `preview still resolves`
- `hasCoverImage: true`

### 8. Clean up the temporary draft

```bash
UXC_DAEMON_EXCLUSIVE='/Users/jolestar/.uxc/webmcp-profile/x' \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.delete \
  '{"id":"2036666046220791808"}'
```

Observed result:

- `ok: true`
- `confirmed: true`

## Stability Notes

- The same draft was successfully read back through `article.getDraft`, `article.listDrafts`, and `article.get(previewUrl)`.
- Cover image state was confirmed from both editor readback and list readback.
- `article.upsertDraftMarkdown` reused the existing draft id instead of creating a duplicate.
- Temporary test drafts created during this regression run were deleted afterward; only the pre-existing user draft remained in `article.listDrafts`.
