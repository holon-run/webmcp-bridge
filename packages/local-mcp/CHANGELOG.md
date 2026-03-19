# @webmcp-bridge/local-mcp

## 0.5.0

### Minor Changes

- Release the latest native-first bridge updates together, including board resource subscriptions,
  the new adapter-utils package, richer X adapter coverage for conversations, replies, Grok chat,
  and file upload/download support, plus local-mcp/runtime contract updates required by these flows.

### Patch Changes

- Updated dependencies
  - @webmcp-bridge/core@0.5.0
  - @webmcp-bridge/playwright@0.5.0
  - @webmcp-bridge/adapter-x@0.5.0
  - @webmcp-bridge/adapter-fixture@0.5.0

## 0.4.3

### Patch Changes

- Document the updated headed-session lifecycle for `bridge.open`.
  - clarify that modern `uxc` + `local-mcp` releases keep headed UI sessions alive after `bridge.open` returns
  - clarify that closing the last headed browser window ends the owner session
  - document that the next `bridge.open` starts a new headed session on the same profile
  - @webmcp-bridge/core@0.4.3
  - @webmcp-bridge/playwright@0.4.3
  - @webmcp-bridge/adapter-x@0.4.3
  - @webmcp-bridge/adapter-fixture@0.4.3

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
