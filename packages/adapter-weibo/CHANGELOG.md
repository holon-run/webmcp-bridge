# @webmcp-bridge/adapter-weibo

## 0.7.0

### Minor Changes

- 3a220ef: Start a unified 0.7.x release line for the public bridge packages and refresh host help after attach when bridge runtime toolsets change.

### Patch Changes

- Updated dependencies [3a220ef]
  - @webmcp-bridge/core@0.7.0
  - @webmcp-bridge/playwright@0.7.0
  - @webmcp-bridge/adapter-utils@0.7.0

## 0.6.1

### Patch Changes

- @webmcp-bridge/core@0.5.4
- @webmcp-bridge/playwright@0.5.4
- @webmcp-bridge/adapter-utils@0.5.4

## 0.6.0

### Minor Changes

- 894b9af: Expand the Weibo adapter from read-only coverage into a broader workflow surface.
  - add Weibo write tools for post creation, comment creation, and article draft/publish flows
  - support markdown-to-article conversion and cover image upload for article publishing
  - improve read behavior with long-text hydration, media extraction, mblogid decoding, and openable Weibo detail URLs
  - add and document the `weibo-webmcp` skill for local-mcp usage

### Patch Changes

- @webmcp-bridge/core@0.5.3
- @webmcp-bridge/playwright@0.5.3
- @webmcp-bridge/adapter-utils@0.5.3
