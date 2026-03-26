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
- `@webmcp-bridge/adapter-weibo`
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

## Skill publishing

Repository skills are released separately from npm packages through ClawHub.

Current published skills:

- `webmcp-bridge`
- `board-webmcp`
- `x-webmcp`
- `google-webmcp`
- `weibo-webmcp`
- `webmcp-adapter-creator`

Release flow:

1. Validate any changed skills locally:
   - `bash skills/webmcp-bridge/scripts/validate.sh`
   - `bash skills/board-webmcp/scripts/validate.sh`
   - `bash skills/x-webmcp/scripts/validate.sh`
   - `bash skills/google-webmcp/scripts/validate.sh`
   - `bash skills/weibo-webmcp/scripts/validate.sh`
   - `bash skills/webmcp-adapter-creator/scripts/validate.sh`
2. Preview the registry changes:

```bash
clawhub sync --all --bump patch --dry-run --changelog "<release note>"
```

3. Publish the changed skills:

```bash
clawhub sync --all --bump patch --changelog "<release note>"
```

Use `--bump minor` or `--bump major` only when the skill contract or workflow changes materially.

## Current release prep

The next release line includes:

- explicit `presentationMode` / `preferredPresentationMode` session state
- `bridge.session.mode.get` and `bridge.session.mode.set`
- single-link skill guidance with explicit runtime mode switching
- `x-webmcp`, `google-webmcp`, and `weibo-webmcp` skills
- stabilized Grok and Gemini long prompt input and long-running wait handling
- Google bootstrap convergence improvements that avoid extra windows
- managed attach mode switching fixes for headed and headless transitions
- X Articles draft lifecycle support: list drafts, read drafts by preview URL, update drafts in place, and confirm cover-image application
- Weibo write flows for posts and comments
- Weibo article drafting and publishing from markdown, including cover image upload
- Weibo long-text hydration, media extraction, short-url decoding, and openable detail URLs
- bridge skill guidance for recovering from bridge-only sessions through `bridge.session.status`, `bridge.session.bootstrap`, and `bridge.session.attach`
