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

## Current release prep

The next `@webmcp-bridge/local-mcp` release includes:

- `bridge.open` / `bridge.close` built-in MCP tools for headed bridge session control
- refresh recovery after page navigation without requiring daemon resets
- owner-session shutdown when the last headed browser window is closed
- the latest board demo / skill docs aligned to the new headed-session lifecycle
