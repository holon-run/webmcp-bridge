# Architecture

`webmcp-bridge` has four layers:

1. `local-mcp`: stdio MCP entrypoint (`tools/list`, `tools/call`) for one site session per process.
2. `playwright`: browser WebMCP page gateway and lifecycle management.
3. `adapter-*`: site-specific fallback logic used only when native WebMCP is unavailable.
4. `core`: shim/runtime contracts shared by fallback implementations.

Current adapter roles:
- `adapter-x`: real X/Twitter fallback adapter.
- `adapter-fixture`: deterministic integration-test adapter.
- external adapter modules: third-party packages loaded by `--adapter-module`.

Native example role:
- `examples/board`: native WebMCP provider example app for shared human + AI diagram editing.

## Runtime flow

1. A local MCP client starts `local-mcp` as a stdio server for one site.
2. `local-mcp` launches a Playwright browser/page and opens the target site URL.
3. `local-mcp` forwards `tools/list` / `tools/call` requests to a Playwright-managed page gateway.
4. The page gateway calls native `navigator.modelContext` when available.
5. If native WebMCP is not present, a shim path is installed and fallback adapter logic handles tool execution.
6. Responses are returned to the local MCP client as JSON-serializable MCP payloads.

## Boundaries

- The project does not store credentials or bypass auth controls.
- Fallback adapter behavior is best-effort and may require selector updates when websites change.
- Native example apps are not adapters and should keep product logic outside shared bridge packages.
