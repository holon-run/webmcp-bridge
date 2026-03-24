---
"@webmcp-bridge/adapter-google": patch
"@webmcp-bridge/adapter-x": patch
"@webmcp-bridge/local-mcp": patch
---

Publish the latest bridge and adapter stabilization work together:

- replace the old headless boolean control plane with explicit presentation mode APIs
- keep managed attach sessions stable across headed and headless mode switches
- improve Google bootstrap convergence and Gemini response detection
- stabilize Grok and Gemini long prompt input plus long-running wait behavior
