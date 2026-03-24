---
name: google-webmcp
description: Connect to Google Search and Gemini through the built-in local-mcp Google adapter and one fixed UXC link. Use when the user wants to run Google searches, chat with Gemini, or download generated Gemini images from an authenticated browser profile.
---

# Google WebMCP

Use this skill to operate Google Search and Gemini through the built-in `--site google` bridge preset in `@webmcp-bridge/local-mcp`.

For generic bridge setup patterns or non-Google sites, switch to `$webmcp-bridge`.

## Prerequisites

- `uxc` is installed and available in `PATH`.
- `npx` is installed and available in `PATH`.
- Network access to `https://www.google.com` and `https://gemini.google.com`.
- On a fresh machine, or under an isolated `HOME`, install Playwright browsers first with `npx playwright install`.
- Gemini is auth-sensitive. Expect `bootstrap_then_attach` behavior when the profile is not signed in yet.

## Core Workflow

1. Ensure the fixed Google link exists:
   - `command -v google-webmcp-cli`
   - if missing or pointed at the wrong profile, run `skills/google-webmcp/scripts/ensure-links.sh`
2. Inspect the bridge and tool schema before calling tools:
   - `google-webmcp-cli -h`
   - `google-webmcp-cli search.web -h`
   - `google-webmcp-cli gemini.chat -h`
   - `google-webmcp-cli gemini.image.download -h`
3. Check authentication state first when Gemini may need sign-in:
   - `google-webmcp-cli bridge.session.status`
   - `google-webmcp-cli auth.get`
   - if the session is not ready, start bootstrap or switch to headed:
     - `google-webmcp-cli bridge.session.bootstrap`
     - `google-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
     - `google-webmcp-cli bridge.open`
4. Use search tools for public search results:
   - `google-webmcp-cli search.web '{"query":"playwright browser automation","limit":10}'`
   - `google-webmcp-cli page.get`
5. Use Gemini through the same authenticated browser profile:
   - text: `google-webmcp-cli gemini.chat '{"prompt":"Summarize these results","mode":"text","timeoutMs":180000}'`
   - image: `google-webmcp-cli gemini.chat '{"prompt":"a watercolor fox reading documentation","mode":"image","timeoutMs":300000}'`
   - download current visible images: `google-webmcp-cli gemini.image.download '{"limit":4,"timeoutMs":120000}'`
6. Use debug and navigation helpers only when necessary:
   - `google-webmcp-cli page.navigate '{"url":"https://gemini.google.com/app"}'`
   - `google-webmcp-cli page.inspect '{"limit":20}'`
7. Parse JSON output only:
   - success path: `.ok == true`, consume `.data`
   - failure path: `.ok == false`, inspect `.error.code` and `.error.message`

## Default Target

The built-in preset uses:

```bash
--site google
```

The default profile path is:

```bash
~/.uxc/webmcp-profile/google
```

Refresh the link with:

```bash
skills/google-webmcp/scripts/ensure-links.sh
```

## Guardrails

- Keep the Google profile isolated from other sites.
- Google uses `bootstrap_then_attach`; do not expect Gemini tools to work until the managed profile is authenticated.
- Prefer explicit `bridge.session.mode.set` over relaunching the command to change runtime mode.
- Long Gemini generations can legitimately take minutes. Increase `timeoutMs` instead of spawning parallel retries.
- `gemini.image.download` works on visible generated images in the current or target conversation. Do not assume it can recover images that are no longer visible.
- `page.navigate` must stay on Google-owned hosts only.
- If the user closes the visible Google window manually, the headed owner session ends. Run `google-webmcp-cli bridge.open` again if you still need a visible session on the same profile.

## References

- Common command patterns:
  - `references/usage-patterns.md`
- Link creation helper:
  - `scripts/ensure-links.sh`
