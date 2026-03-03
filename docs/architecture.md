# Architecture

`webmcp-bridge` has four layers:

1. `core`: modelContext shim and runtime contracts.
2. `playwright`: page injection, callback bridge, and lifecycle management.
3. `adapter-*`: site-specific tool mapping (`x.*` in v0.1).
4. `local-mcp`: local host process with Unix socket MCP transport (JSON-RPC + SSE).

## Runtime flow

1. Playwright opens a user-authenticated web session.
2. `attachBridge` injects a shim when native `navigator.modelContext` is unavailable.
3. Tool calls from the page are forwarded to Node via exposed callback.
4. Adapter executes site logic and returns JSON-serializable results.

## Boundaries

- The project does not store credentials or bypass auth controls.
- Adapter behavior is best-effort and may require selector updates when websites change.
