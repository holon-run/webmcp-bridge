# Architecture

`webmcp-bridge` has four layers.

## Layers

1. `local-mcp`
   One-site stdio MCP server. It exposes `tools/list`, `tools/call`, and the reserved `bridge.*` controls.
2. `playwright`
   Browser page gateway, page lifecycle, and runtime dispatch.
3. `adapter-*`
   Fallback site logic used only when native WebMCP is unavailable.
4. `core`
   Shared contracts and shim/runtime behavior for fallback paths.

## Native-First Flow

1. local client starts `local-mcp`
2. `local-mcp` opens a browser page through Playwright
3. Playwright checks whether the page exposes native `navigator.modelContext`
4. if native WebMCP exists, the bridge forwards tool discovery and calls directly
5. if not, the bridge installs shim behavior and dispatches to an adapter

## Boundaries

- adapters should stay thin and site-specific
- bridge layers should stay site-agnostic
- credentials stay in the browser profile, not in local scripts
- ambiguous upstream states fail closed

## Example App

The repo also contains a native browser example:

- `examples/board`

It is a WebMCP provider example, not a fallback adapter.
