# Adapter X

`@webmcp-bridge/adapter-x` provides the real fallback adapter for X/Twitter flows when a page does not expose native `navigator.modelContext`.

## Tools

- `auth.get`: detect `authenticated`, `auth_required`, or `challenge_required`.
- `timeline.list`: read timeline tweet cards.
- `tweet.get`: read one tweet by URL or ID.
- `favorites.list`: read bookmarks/favorites tweet cards.
- `user.get`: read a user profile summary by handle.
- `tweet.create`: submit a text post with optional `dryRun`.

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
