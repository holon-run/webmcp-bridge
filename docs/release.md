# Release

This repository uses Changesets for versioning.

## Commands

```bash
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

## Package channels

Public packages:

- `@webmcp-bridge/core`
- `@webmcp-bridge/playwright`
- `@webmcp-bridge/adapter-fixture`
- `@webmcp-bridge/adapter-x`
- `@webmcp-bridge/local-mcp` (beta tag)
- `@webmcp-bridge/testkit`

## Beta policy (`0.x`)

- `@webmcp-bridge/local-mcp` is published as beta.
- Breaking changes are allowed while APIs are still stabilizing.
- Every breaking change must be recorded in changesets/changelog.
