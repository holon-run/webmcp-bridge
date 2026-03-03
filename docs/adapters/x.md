# Adapter X

`@webmcp-bridge/adapter-x` provides the real fallback adapter for X/Twitter flows when a page does not expose native `navigator.modelContext`.

## Tools

- `x.health`: adapter availability check.
- `x.auth_state`: detect `authenticated`, `auth_required`, or `challenge_required`.
- `x.timeline.read`: read timeline text snippets (read-only).
- `x.compose.send`: submit a text post with optional `dryRun`.

## Behavior

- Auth gating is fail-closed:
  - returns `AUTH_REQUIRED` when session is not logged in;
  - returns `CHALLENGE_REQUIRED` when challenge/verification UI is detected.
- Compose is confirmation-based:
  - submit is not treated as success until timeline confirmation succeeds;
  - returns `ACTION_UNCONFIRMED` if confirmation times out.
- Error payloads are stable JSON with `error.code` and `error.message`.

## Known limits

- Selector-based implementation; upstream UI changes may require selector updates.
- Text-only compose scope in `0.1.x`.
- Requires user already logged in on web session.
