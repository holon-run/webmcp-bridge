# Adapter: Google And Gemini

`@webmcp-bridge/adapter-google` handles Google and Gemini fallback automation when native WebMCP is unavailable.

## Current Focus Areas

- Gemini text generation
- Gemini image generation
- session recovery for auth-sensitive flows

## Current Behavior

The adapter has been hardened around:

- long prompt input without repeated typing interrupts
- long-running waits that stay alive while the page is still active
- Google bootstrap convergence, to reduce extra windows
- current Gemini image flow and overlay handling

## Session Guidance

Google is auth-sensitive. In practice, the first useful step is often:

```bash
google-webmcp-cli bridge.session.status
```

If page tools are not ready yet, use the recovery flow in:

- [Bridge Session Model](../reference/session-lifecycle.md)
