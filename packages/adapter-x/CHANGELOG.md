# @webmcp-bridge/adapter-x

## 0.5.4

### Patch Changes

- @webmcp-bridge/core@0.5.4
- @webmcp-bridge/playwright@0.5.4
- @webmcp-bridge/adapter-utils@0.5.4

## 0.5.3

### Patch Changes

- @webmcp-bridge/core@0.5.3
- @webmcp-bridge/playwright@0.5.3
- @webmcp-bridge/adapter-utils@0.5.3

## 0.5.2

### Patch Changes

- 1174fd5: Patch release for the latest bridge and adapter stabilization work.
  - stabilize Google/Gemini image generation and long-running session recovery
  - improve X Articles support with draft lifecycle tools and stable preview/edit readback
  - clarify bridge-only recovery guidance for attached browser sessions
  - @webmcp-bridge/core@0.5.2
  - @webmcp-bridge/playwright@0.5.2
  - @webmcp-bridge/adapter-utils@0.5.2

## 0.5.1

### Patch Changes

- 7c6d4df: Publish the latest bridge and adapter stabilization work together:
  - replace the old headless boolean control plane with explicit presentation mode APIs
  - keep managed attach sessions stable across headed and headless mode switches
  - improve Google bootstrap convergence and Gemini response detection
  - stabilize Grok and Gemini long prompt input plus long-running wait behavior
  - @webmcp-bridge/core@0.5.1
  - @webmcp-bridge/playwright@0.5.1
  - @webmcp-bridge/adapter-utils@0.5.1

## 0.5.0

### Minor Changes

- Release the latest native-first bridge updates together, including board resource subscriptions,
  the new adapter-utils package, richer X adapter coverage for conversations, replies, Grok chat,
  and file upload/download support, plus local-mcp/runtime contract updates required by these flows.

### Patch Changes

- Updated dependencies
  - @webmcp-bridge/adapter-utils@0.5.0
  - @webmcp-bridge/core@0.5.0
  - @webmcp-bridge/playwright@0.5.0

## 0.4.3

### Patch Changes

- @webmcp-bridge/core@0.4.3
- @webmcp-bridge/playwright@0.4.3

## 0.4.2

### Patch Changes

- @webmcp-bridge/core@0.4.2
- @webmcp-bridge/playwright@0.4.2

## 0.4.1

### Patch Changes

- @webmcp-bridge/core@0.4.1
- @webmcp-bridge/playwright@0.4.1

## 0.4.0

### Minor Changes

- Unify public package versions and publish the latest native-first bridge, Playwright gateway, and adapter updates together so npm consumers resolve a consistent dependency set.

### Patch Changes

- Updated dependencies
  - @webmcp-bridge/core@0.4.0
  - @webmcp-bridge/playwright@0.4.0
