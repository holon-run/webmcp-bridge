---
"@webmcp-bridge/agent-browser-core": patch
"@webmcp-bridge/core": patch
"@webmcp-bridge/playwright": patch
"@webmcp-bridge/local-mcp": patch
"@webmcp-bridge/adapter-google": patch
"@webmcp-bridge/adapter-x": patch
"@webmcp-bridge/adapter-weibo": patch
"@webmcp-bridge/adapter-utils": patch
"@webmcp-bridge/adapter-fixture": patch
"@webmcp-bridge/testkit": patch
---

Tighten local-mcp startup resilience for slow remote sites.

- make navigation timeouts configurable with `--navigation-timeout-ms` and `WEBMCP_NAVIGATION_TIMEOUT_MS`
- raise the default timeout for remote targets while keeping localhost fast-fail behavior
- improve `NAVIGATION_TIMEOUT` errors with the active timeout and remediation hints
