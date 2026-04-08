# @webmcp-bridge/local-mcp

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
  - @webmcp-bridge/agent-browser-core@0.8.0
  - @webmcp-bridge/core@0.8.0
  - @webmcp-bridge/playwright@0.8.0
  - @webmcp-bridge/adapter-google@0.8.0
  - @webmcp-bridge/adapter-x@0.8.0
  - @webmcp-bridge/adapter-weibo@0.8.0
  - @webmcp-bridge/adapter-fixture@0.8.0

## 0.7.0

### Minor Changes

- 3a220ef: Start a unified 0.7.x release line for the public bridge packages and refresh host help after attach when bridge runtime toolsets change.

### Patch Changes

- Updated dependencies [3a220ef]
  - @webmcp-bridge/core@0.7.0
  - @webmcp-bridge/playwright@0.7.0
  - @webmcp-bridge/adapter-google@0.7.0
  - @webmcp-bridge/adapter-x@0.7.0
  - @webmcp-bridge/adapter-weibo@0.7.0
  - @webmcp-bridge/adapter-fixture@0.7.0
  - @webmcp-bridge/agent-browser-core@0.7.0

## 0.5.4

### Patch Changes

- 490cb45: Add MCP service-level recovery instructions so clients that only see `bridge.*` tools know to check session status, bootstrap sign-in when needed, and attach again to expose site tools.
- bbc36b6: Improve `local-mcp` session recovery and process lifecycle management by exposing the `uxc/can_reap` contract, cleaning up managed Chromium processes more aggressively, and recovering Google attach sessions from stale persisted CDP metadata.
  - @webmcp-bridge/core@0.5.4
  - @webmcp-bridge/playwright@0.5.4
  - @webmcp-bridge/adapter-google@0.5.4
  - @webmcp-bridge/adapter-x@0.5.4
  - @webmcp-bridge/adapter-fixture@0.5.4
  - @webmcp-bridge/adapter-weibo@0.6.1

## 0.5.3

### Patch Changes

- Updated dependencies [894b9af]
  - @webmcp-bridge/adapter-weibo@0.6.0
  - @webmcp-bridge/core@0.5.3
  - @webmcp-bridge/playwright@0.5.3
  - @webmcp-bridge/adapter-google@0.5.3
  - @webmcp-bridge/adapter-x@0.5.3
  - @webmcp-bridge/adapter-fixture@0.5.3

## 0.5.2

### Patch Changes

- 1174fd5: Patch release for the latest bridge and adapter stabilization work.
  - stabilize Google/Gemini image generation and long-running session recovery
  - improve X Articles support with draft lifecycle tools and stable preview/edit readback
  - clarify bridge-only recovery guidance for attached browser sessions

- Updated dependencies [1174fd5]
  - @webmcp-bridge/adapter-google@0.5.2
  - @webmcp-bridge/adapter-x@0.5.2
  - @webmcp-bridge/core@0.5.2
  - @webmcp-bridge/playwright@0.5.2
  - @webmcp-bridge/adapter-fixture@0.5.2

## 0.5.1

### Patch Changes

- 7c6d4df: Publish the latest bridge and adapter stabilization work together:
  - replace the old headless boolean control plane with explicit presentation mode APIs
  - keep managed attach sessions stable across headed and headless mode switches
  - improve Google bootstrap convergence and Gemini response detection
  - stabilize Grok and Gemini long prompt input plus long-running wait behavior

- Updated dependencies [7c6d4df]
  - @webmcp-bridge/adapter-google@0.5.1
  - @webmcp-bridge/adapter-x@0.5.1
  - @webmcp-bridge/core@0.5.1
  - @webmcp-bridge/playwright@0.5.1
  - @webmcp-bridge/adapter-fixture@0.5.1

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
