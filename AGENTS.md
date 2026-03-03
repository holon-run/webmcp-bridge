# Repository Guidelines

## Mission
`webmcp-bridge` provides a local-to-browser WebMCP bridge with a unified call path:
`local-mcp -> playwright -> browser navigator.modelContext`.
The system is native-first and uses shim fallback when a website does not expose native WebMCP.
The architecture is split into:
- `@webmcp-bridge/local-mcp`: local stdio MCP entrypoint (one site session per process) that proxies tool requests to a browser page gateway.
- `@webmcp-bridge/playwright`: browser WebMCP page gateway and lifecycle management (native-first, shim fallback).
- `@webmcp-bridge/adapter-*`: site-specific fallback tool mapping, used only when native WebMCP is unavailable.
- `@webmcp-bridge/core`: shared WebMCP-compatible runtime/shim contracts used by fallback paths.

## Current Priorities
1. Stabilize stdio MCP semantics in `local-mcp`: one-site process lifecycle and strict proxying to Playwright page gateway for `tools/list` and `tools/call`.
2. Harden native-first behavior and shim fallback in `playwright`, especially around navigation/frame lifecycle edge cases.
3. Keep adapters thin and replaceable as fallback-only components; business logic must not leak into shared layers.
4. Expand contract coverage for `native` vs `shim` behavior before adding new sites/features.

## Guardrails
- Do not implement credential vaulting or auth bypass.
- Assume user is already authenticated in browser session.
- Fail closed on ambiguous upstream states (`AUTH_REQUIRED`, `UPSTREAM_CHANGED`, etc.).
- Keep MCP payloads JSON-serializable and schema-friendly.
- Preserve single responsibility per package; avoid cross-package implicit coupling.
- Prefer browser-side WebMCP execution for privileged site actions; do not move site credentials into local-mcp.

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
- Native-first WebMCP strategy in Playwright gateway with shim fallback.
- Gateway-first architecture: `local-mcp` routes calls to browser WebMCP via Playwright.
- stdio MCP process model: one site session per local-mcp process.

Pending (non-blocking):
- Add richer site presets and optional external browser attachment after stdio MVP hardening.
- Remove remaining adapter-first legacy surfaces after migration completion.
