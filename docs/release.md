# Release

This repository uses Changesets for versioning.

## Commands

```bash
pnpm changeset
```

## Package channels

Public packages:

- `@webmcp-bridge/core`
- `@webmcp-bridge/playwright`
- `@webmcp-bridge/adapter-utils`
- `@webmcp-bridge/adapter-fixture`
- `@webmcp-bridge/adapter-google`
- `@webmcp-bridge/adapter-x`
- `@webmcp-bridge/local-mcp` (beta tag)
- `@webmcp-bridge/testkit`

## Beta policy (`0.x`)

- `@webmcp-bridge/local-mcp` is published as beta.
- Breaking changes are allowed while APIs are still stabilizing.
- Every breaking change must be recorded in changesets/changelog.

## Trusted publishing

Publishing is performed by GitHub Actions through npm trusted publishing.

Required repository-side setup:

- Add this repository and the `.github/workflows/release.yml` workflow as an npm trusted publisher for the package scope.
- Use a GitHub-hosted runner.
- Keep `id-token: write` permission on the release workflow.
- Keep package `repository` metadata aligned with `github.com/holon-run/webmcp-bridge`.

The release workflow:

1. Runs on `push` to `main` and on manual `workflow_dispatch`.
2. Validates the repo with `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build`.
3. Uses Changesets to:
   - open or update a version PR when unreleased changesets exist
   - publish versioned packages after that version PR is merged
4. Publishes through npm trusted publishing with provenance enabled, without an `NPM_TOKEN` secret.

Feature PR expectations:

- Add a changeset for any publishable package change.
- Do not run `pnpm changeset version` locally on feature branches.
- Merge the generated release PR to publish.

## Current release prep

The next `@webmcp-bridge/local-mcp` release includes:

- explicit `presentationMode` / `preferredPresentationMode` session state
- `bridge.session.mode.get` and `bridge.session.mode.set`
- single-link skill guidance with explicit runtime mode switching
- new `x-webmcp` and `google-webmcp` skills
- stabilized Grok and Gemini long prompt input and long-running wait handling
- Google bootstrap convergence improvements that avoid extra windows
- managed attach mode switching fixes for headed and headless transitions
