# Security

## Principles

- Operate only inside user-owned authenticated browser sessions.
- Keep tokens/cookies in browser profile storage; avoid exporting secrets.
- Return least data needed for tool responses.

## Operational guidance

- Run with dedicated automation profiles per account.
- Keep adapter logging redacted by default.
- Treat unknown upstream UI states as errors (`AUTH_REQUIRED`, `UPSTREAM_CHANGED`).
