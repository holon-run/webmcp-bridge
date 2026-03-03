# Repository Guidelines

## Mission
`webmcp-bridge` provides a compatibility layer for websites that do not yet natively support `navigator.modelContext`.
The architecture is split into:
- `@webmcp-bridge/core`: WebMCP-compatible runtime/shim contracts.
- `@webmcp-bridge/playwright`: injection, lifecycle, and Node <-> page bridge.
- `@webmcp-bridge/adapter-*`: site-specific tool mapping.
- `@webmcp-bridge/local-mcp`: local Unix-socket MCP host/client (JSON-RPC + SSE).

## Current Priorities
1. Stabilize `local-mcp` transport semantics (replay, overflow, reconnect behavior).
2. Harden `playwright` injection against navigation/frame lifecycle edge cases.
3. Keep adapters thin and replaceable; business logic must not leak into core/playwright.
4. Expand contract tests (`native` vs `shim`) before adding new features.

## Guardrails
- Do not implement credential vaulting or auth bypass.
- Assume user is already authenticated in browser session.
- Fail closed on ambiguous upstream states (`AUTH_REQUIRED`, `UPSTREAM_CHANGED`, etc.).
- Keep MCP payloads JSON-serializable and schema-friendly.
- Preserve single responsibility per package; avoid cross-package implicit coupling.

## Coding Rules
- Language: TypeScript ESM, 2-space indentation.
- Every source file must start with a short module header comment describing:
  - module responsibility;
  - dependency relationship with other modules.
- Prefer small pure utilities and explicit error mapping.
- Avoid introducing site-specific constants into shared packages.

## Development Workflow
- Install: `pnpm install`
- Validate: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
- Tests live under each package: `packages/*/test/*.test.ts`.
- Use Conventional Commits (e.g., `feat(local-mcp): ...`).

## Migration Notes
Already migrated from `agent-account-bridge` (high priority):
- Unix-socket MCP JSON-RPC + SSE client/server pattern.
- Replay ring buffer and `REPLAY_OVERFLOW` semantics.
- Native-first WebMCP shim strategy in Playwright injection.

Pending (non-blocking):
- Extract reusable idempotency/cursor primitives into shared `local-mcp` internals.
- Add a standard `transport` package if multiple host transports appear.
