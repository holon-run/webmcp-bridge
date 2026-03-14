# @webmcp-bridge/local-mcp

## 0.4.2

### Patch Changes

- Rebuild the published local-mcp package so the distributed CLI reports the package version correctly and `bridge.open` can reopen a closed headed browser page.
  - @webmcp-bridge/core@0.4.2
  - @webmcp-bridge/playwright@0.4.2
  - @webmcp-bridge/adapter-x@0.4.2
  - @webmcp-bridge/adapter-fixture@0.4.2

## 0.4.1

### Patch Changes

- Reopen the browser page when `bridge.open` is called after the user manually closes the window, instead of leaving the MCP session in a dead headed state.
  - @webmcp-bridge/core@0.4.1
  - @webmcp-bridge/playwright@0.4.1
  - @webmcp-bridge/adapter-x@0.4.1
  - @webmcp-bridge/adapter-fixture@0.4.1

## 0.4.0

### Minor Changes

- Unify public package versions and publish the latest native-first bridge, Playwright gateway, and adapter updates together so npm consumers resolve a consistent dependency set.

### Patch Changes

- Updated dependencies
  - @webmcp-bridge/core@0.4.0
  - @webmcp-bridge/playwright@0.4.0
  - @webmcp-bridge/adapter-x@0.4.0
  - @webmcp-bridge/adapter-fixture@0.4.0

## 0.3.0

### Minor Changes

- 26e4cc5: Add a `--browser-channel` option so chromium-based local-mcp sessions can use installed Chrome or Edge channels instead of the default Playwright browser.

## 0.2.0

### Minor Changes

- 6c2921f: Add built-in `bridge.open` and `bridge.close` MCP tools for headed session control, and improve fast failure for unreachable navigation targets.
