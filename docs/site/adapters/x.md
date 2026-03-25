# Adapter: X

`@webmcp-bridge/adapter-x` supports X and Twitter when native WebMCP is unavailable.

## Key Tool Areas

- timeline reads
- search
- tweet creation and deletion
- Grok chat
- X Articles

## X Articles

Recent article support includes:

- `article.get`
- `article.getDraft`
- `article.listDrafts`
- `article.draftMarkdown`
- `article.upsertDraftMarkdown`
- `article.publishMarkdown`
- `article.setCoverImage`
- `article.delete`

The current article flow supports:

- draft creation from markdown
- stable `draftId`, `editUrl`, and `previewUrl`
- reading drafts back by id or preview URL
- cover-image confirmation
- updating an existing draft in place

## Session Guidance

X is auth-sensitive. Expect bootstrap or attach to be needed on first use of a fresh profile.

See:

- [Bridge Session Model](../reference/session-lifecycle.md)
- [Manual X Draft Lifecycle Test](../tests/x-article-draft-lifecycle.md)
