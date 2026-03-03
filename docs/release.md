# Release

This repository uses Changesets for versioning.

## Commands

```bash
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

## v0.1 release scope

Published:
- `@webmcp-bridge/core`
- `@webmcp-bridge/playwright`
- `@webmcp-bridge/adapter-fixture`
- `@webmcp-bridge/adapter-x`

Architecture-critical but currently private:
- `@webmcp-bridge/local-mcp` (stdio MCP site session host and page-gateway proxy entrypoint)
