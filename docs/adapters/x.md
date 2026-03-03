# Adapter X (MVP)

`@webmcp-bridge/adapter-x` provides a starter fallback adapter for X/Twitter-like flows.
It is intended for shim fallback scenarios when a website does not expose native `navigator.modelContext`.

## Tools

- `x.health`: basic adapter readiness check.
- `x.auth_state`: detect whether the current page appears authenticated.
- `x.timeline.read`: return timeline text snippets.
- `x.compose.send`: send a short text post.

## Known limits

- Selector-based; UI changes can break behavior.
- Text-only scope in `0.1.x`.
- Requires user already logged in on web session.
- Not part of the native-first browser WebMCP path.
