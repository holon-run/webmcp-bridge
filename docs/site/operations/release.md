# Release And Publishing

This project has two release channels:

- npm packages through Changesets plus GitHub Actions trusted publishing
- agent skills through ClawHub

## npm Packages

Workflow:

1. land a changeset on `main`
2. let the `Release` workflow generate or update `changeset-release/main`
3. merge the version PR
4. let GitHub Actions publish packages with npm provenance

## Skills

Validate changed skills locally:

```bash
bash skills/webmcp-bridge/scripts/validate.sh
bash skills/board-webmcp/scripts/validate.sh
bash skills/x-webmcp/scripts/validate.sh
bash skills/google-webmcp/scripts/validate.sh
bash skills/webmcp-adapter-creator/scripts/validate.sh
```

Preview the skill release:

```bash
clawhub sync --all --bump patch --dry-run --changelog "<release note>"
```

Publish the changed skills:

```bash
clawhub sync --all --bump patch --changelog "<release note>"
```

## Current Release Themes

The latest release line covers:

- explicit `presentationMode` and bridge session controls
- single-link site skill guidance
- X and Google wrapper skills
- Gemini image-flow stabilization
- X Articles draft lifecycle support
