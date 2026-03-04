# Contributing

Thanks for contributing to `webmcp-bridge`.

## Development setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Pull request requirements

- Keep package boundaries strict (`core` / `playwright` / `adapter-*` / `local-mcp`).
- Keep payloads JSON-serializable and schema-friendly.
- Add tests for behavior changes.
- Use Conventional Commits (`feat(local-mcp): ...`).

## Adapter changes

If adding or changing adapters:

- keep site-specific logic inside adapter package
- fail closed on uncertain upstream states
- update docs under `docs/adapters/`

## Reporting issues

- Security-sensitive reports: see [SECURITY.md](SECURITY.md).
- Bug reports and feature requests: open a GitHub issue with reproduction steps.
