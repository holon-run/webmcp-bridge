# Security

## Principles

- Operate only inside user-owned authenticated browser sessions.
- Keep tokens/cookies in browser profile storage; avoid exporting secrets.
- Execute privileged site actions through browser-side WebMCP or shim fallback paths, not by storing external credentials in local-mcp.
- Return least data needed for tool responses.

## Operational guidance

- Run with dedicated automation profiles per account.
- Keep adapter logging redacted by default.
- Treat unknown upstream UI states as errors (`AUTH_REQUIRED`, `UPSTREAM_CHANGED`).
