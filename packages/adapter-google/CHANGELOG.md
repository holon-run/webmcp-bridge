# @webmcp-bridge/adapter-google

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
