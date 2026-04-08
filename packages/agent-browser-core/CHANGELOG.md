# @webmcp-bridge/agent-browser-core

## 0.8.0

### Minor Changes

- b6b6d96: Ship the agent-browser extraction and overlay authoring release.

  Highlights:
  - extract `@webmcp-bridge/agent-browser-core` as the shared browser session lifecycle layer
  - move bridge lifecycle orchestration out of `local-mcp` and harden managed-browser cleanup after abnormal exits
  - add `overlay-bootstrap` mode so adapterless sites can still open and be iterated in-place
  - add persistent overlays with `bridge.debug.eval`, `bridge.overlay.*`, export-to-draft, and per-tool `override` activation
  - slim the bridge skill docs so they point at the live docs and search API instead of drifting local copies

### Patch Changes

- Updated dependencies [b6b6d96]
  - @webmcp-bridge/playwright@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [3a220ef]
  - @webmcp-bridge/playwright@0.7.0
