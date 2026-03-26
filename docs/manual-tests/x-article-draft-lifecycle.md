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

- Define reusable local variables:
  - `REPO_ROOT`: path to this repository checkout
  - `PROFILE_DIR`: X browser profile directory with a valid login
  - `WORK_DIR`: temp directory holding the markdown inputs for this test
  - `COVER_IMAGE_PATH`: local image file used as the article cover
- Local worktree is built:
  - `pnpm --filter @webmcp-bridge/adapter-x build`
  - `pnpm --filter @webmcp-bridge/local-mcp build`
- X login is already valid in `PROFILE_DIR`
- Use the adapter-backed compose endpoint so X stays in `adapter-shim` mode:

```bash
export REPO_ROOT=/path/to/webmcp-bridge
export PROFILE_DIR="$HOME/.uxc/webmcp-profile/x"
export WORK_DIR=/tmp/issue35-x-flow
export COVER_IMAGE_PATH=/path/to/cover.png
export ISSUE35_ENDPOINT="node $REPO_ROOT/packages/local-mcp/dist/cli.js \
  --adapter-module $REPO_ROOT/packages/adapter-x/dist/index.js \
  --url https://x.com/compose/articles \
  --headless \
  --no-auto-login-fallback \
  --user-data-dir $PROFILE_DIR \
  --service-version issue35-v6"
```

## Test Inputs

- Markdown create file:
  - `$WORK_DIR/post.md`
- Markdown update file:
  - `$WORK_DIR/post-updated.md`
- Cover image:
  - `$COVER_IMAGE_PATH`

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
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.draftMarkdown \
  "{\"markdownPath\":\"$WORK_DIR/post.md\"}"
```

Observed result:

- `draftId`: `2036666046220791808`
- `editUrl`: `https://x.com/compose/articles/edit/2036666046220791808`
- `previewUrl`: `https://x.com/i/articles/2036666046220791808/preview`
- `persisted`: `false`
- `sessionScoped`: `true`

### 2. Add a cover image

```bash
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.setCoverImage \
  "{\"id\":\"2036666046220791808\",\"coverImagePath\":\"$COVER_IMAGE_PATH\"}"
```

Observed result:

- `ok: true`
- `hasCoverImage: true`

### 3. Read the draft by id

```bash
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
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
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.listDrafts '{}'
```

Observed result:

- draft `2036666046220791808` is present
- `hasCoverImage: true`
- `previewUrl` and `editUrl` match the create response

### 5. Read the same draft by preview URL

```bash
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
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
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
UXC_LINK_NAME='x-webmcp-issue35-compose-v6' \
uxc "$ISSUE35_ENDPOINT" article.upsertDraftMarkdown \
  "{\"id\":\"2036666046220791808\",\"markdownPath\":\"$WORK_DIR/post-updated.md\"}"
```

Observed result:

- returned the same `draftId`
- no duplicate draft was created
- `previewUrl` stayed stable

### 7. Read back after update

```bash
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
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
UXC_DAEMON_EXCLUSIVE="$PROFILE_DIR" \
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
