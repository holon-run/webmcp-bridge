---
"@webmcp-bridge/agent-browser-core": minor
"@webmcp-bridge/core": minor
"@webmcp-bridge/playwright": minor
"@webmcp-bridge/local-mcp": minor
"@webmcp-bridge/adapter-google": minor
"@webmcp-bridge/adapter-x": minor
"@webmcp-bridge/adapter-weibo": minor
"@webmcp-bridge/adapter-utils": minor
"@webmcp-bridge/adapter-fixture": minor
"@webmcp-bridge/testkit": minor
---

Ship the agent-browser extraction and overlay authoring release.

Highlights:

- extract `@webmcp-bridge/agent-browser-core` as the shared browser session lifecycle layer
- move bridge lifecycle orchestration out of `local-mcp` and harden managed-browser cleanup after abnormal exits
- add `overlay-bootstrap` mode so adapterless sites can still open and be iterated in-place
- add persistent overlays with `bridge.debug.eval`, `bridge.overlay.*`, export-to-draft, and per-tool `override` activation
- slim the bridge skill docs so they point at the live docs and search API instead of drifting local copies
