# X Read Completeness Plan

This document defines the implementation plan to complete read-side capability coverage for adapter-x.

## Scope

1. Rename `timeline.list` to `timeline.home.list`.
2. Add `timeline.user.list`.
3. Add `search.tweets.list`.

No compatibility layer is required in this phase (breaking change accepted).

## Plan

1. Naming Refactor
- Replace `timeline.list` with `timeline.home.list`.
- Keep the existing pagination contract unchanged:
  - input: `limit`, optional `cursor`
  - output: `items`, `source`, `hasMore`, optional `nextCursor`, optional `debug.reason`
- Update all call sites, tests, docs, and examples.

2. Add `timeline.user.list`
- Input schema:
  - `username` (required)
  - `limit` (optional)
  - `cursor` (optional)
- Behavior:
  - open/reuse `https://x.com/<username>` read page
  - network template first, DOM fallback
- Output schema:
  - same as `timeline.home.list`

3. Add `search.tweets.list`
- Input schema:
  - `query` (required)
  - `limit` (optional)
  - `cursor` (optional)
  - `mode` (optional, default `latest`, allowed: `top | latest`)
- Behavior:
  - open/reuse search page (`https://x.com/search?...`)
  - network template first, DOM fallback
- Output schema:
  - same as `timeline.home.list`

4. Extend Reuse/Caching Strategy
- Extend process-level template cache buckets:
  - `home`, `bookmarks`, `tweet`, `user_timeline`, `search`
- Extend read-page cache keys:
  - `home`
  - `bookmarks`
  - `user:<username>`
  - `search:<query>:<mode>`
- Add simple bounds/LRU policy to avoid unbounded cache growth.

5. Tests
- Update tool-list and routing tests for renamed method.
- Add tests for:
  - `timeline.user.list` (validation, pagination cursor, fallback/debug)
  - `search.tweets.list` (validation, mode handling, cursor pagination)
  - process-template-cache fallback path for new tools
- Keep existing behavior tests green.

6. Docs and Examples
- Update `docs/adapters/x.md` with the three timeline/search tools.
- Add pagination usage snippets for:
  - home timeline
  - user timeline
  - search tweets
- Explicitly note: `timeline.list` is removed in this phase.

## Acceptance Criteria

1. Via `x-webmcp-cli`, the following tools are callable and paginatable:
- `timeline.home.list`
- `timeline.user.list`
- `search.tweets.list`

2. Responses expose:
- `source` (`network` or `dom`)
- `hasMore`
- `nextCursor` when available
- `debug.reason` when `source=dom`

3. Project validation passes:
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
