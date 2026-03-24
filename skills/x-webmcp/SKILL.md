---
name: x-webmcp
description: Connect to X and Grok through the built-in local-mcp X adapter and one fixed UXC link. Use when the user wants to read timelines, inspect tweets, post on X, or chat with Grok from an authenticated browser profile.
---

# X WebMCP

Use this skill to operate X through the built-in `--site x` bridge preset in `@webmcp-bridge/local-mcp`.

For generic bridge setup patterns or non-X sites, switch to `$webmcp-bridge`.

## Prerequisites

- `uxc` is installed and available in `PATH`.
- `npx` is installed and available in `PATH`.
- Network access to `https://x.com`.
- On a fresh machine, or under an isolated `HOME`, install Playwright browsers first with `npx playwright install`.
- X is auth-sensitive. Expect `bootstrap_then_attach` behavior when the profile is not signed in yet.

## Core Workflow

1. Ensure the fixed X link exists:
   - `command -v x-webmcp-cli`
   - if missing or pointed at the wrong profile, run `skills/x-webmcp/scripts/ensure-links.sh`
2. Inspect the bridge and tool schema before calling tools:
   - `x-webmcp-cli -h`
   - `x-webmcp-cli timeline.home.list -h`
   - `x-webmcp-cli grok.chat -h`
   - `x-webmcp-cli article.publishMarkdown -h`
3. Check authentication state first when the profile is new or looks stale:
   - `x-webmcp-cli bridge.session.status`
   - `x-webmcp-cli auth.get`
   - if the session is not ready, start bootstrap or switch to headed:
     - `x-webmcp-cli bridge.session.bootstrap`
     - `x-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
     - `x-webmcp-cli bridge.open`
4. Use read tools for timelines, conversations, and profiles:
   - `x-webmcp-cli timeline.home.list limit=10`
   - `x-webmcp-cli search.tweets.list '{"query":"playwright","mode":"latest","limit":10}'`
   - `x-webmcp-cli tweet.get '{"url":"https://x.com/.../status/..."}'`
   - `x-webmcp-cli tweet.conversation.get '{"id":"2033895522382319922","limit":10}'`
   - `x-webmcp-cli user.get username=jack`
5. Use write tools only after reading help and confirming user intent:
   - `x-webmcp-cli tweet.create '{"text":"hello from webmcp","dryRun":true}'`
   - `x-webmcp-cli tweet.reply '{"id":"2033895522382319922","text":"reply text","dryRun":true}'`
   - `x-webmcp-cli article.publishMarkdown '{"markdownPath":"/abs/path/post.md","dryRun":true}'`
6. Use Grok through the same authenticated X session:
   - `x-webmcp-cli grok.chat '{"prompt":"Summarize this thread","timeoutMs":180000}'`
   - for uploads, pass absolute local file paths in `attachmentPaths`
7. Parse JSON output only:
   - success path: `.ok == true`, consume `.data`
   - failure path: `.ok == false`, inspect `.error.code` and `.error.message`

## Default Target

The built-in preset uses:

```bash
--site x
```

The default profile path is:

```bash
~/.uxc/webmcp-profile/x
```

Refresh the link with:

```bash
skills/x-webmcp/scripts/ensure-links.sh
```

## Guardrails

- Keep the X profile isolated from other sites.
- X uses `bootstrap_then_attach`; do not expect page tools to work until the managed profile is authenticated.
- Prefer explicit `bridge.session.mode.set` over relaunching the command to change runtime mode.
- `grok.chat` and article publishing can take a long time. Increase `timeoutMs` instead of retrying aggressively.
- For local uploads such as `attachmentPaths`, `markdownPath`, or `coverImagePath`, always use absolute filesystem paths.
- Use `dryRun` for destructive or public write tools first when available.
- If the user closes the visible X window manually, the headed owner session ends. Run `x-webmcp-cli bridge.open` again if you still need a visible session on the same profile.

## References

- Common command patterns:
  - `references/usage-patterns.md`
- Link creation helper:
  - `scripts/ensure-links.sh`
