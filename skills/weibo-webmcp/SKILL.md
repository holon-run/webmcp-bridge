---
name: weibo-webmcp
description: Connect to Weibo through the built-in local-mcp Weibo adapter and one fixed UXC link. Use when the user wants to read timelines, inspect posts, browse user profiles, or run Weibo search from an authenticated browser profile.
---

# Weibo WebMCP

Use this skill to operate Weibo through the built-in `--site weibo` bridge preset in `@webmcp-bridge/local-mcp`.

For generic bridge setup patterns or non-Weibo sites, switch to `$webmcp-bridge`.

## Prerequisites

- `uxc` is installed and available in `PATH`.
- `npx` is installed and available in `PATH`.
- Network access to `https://weibo.com` and `https://s.weibo.com`.
- On a fresh machine, or under an isolated `HOME`, install Playwright browsers first with `npx playwright install`.
- Weibo is auth-sensitive. Expect `bootstrap_then_attach` behavior when the profile is not signed in yet.

## Core Workflow

1. Ensure the fixed Weibo link exists:
   - `command -v weibo-webmcp-cli`
   - if missing or pointed at the wrong profile, run `skills/weibo-webmcp/scripts/ensure-links.sh`
2. Inspect the bridge and tool schema before calling tools:
   - `weibo-webmcp-cli -h`
   - `weibo-webmcp-cli timeline.home.list -h`
   - `weibo-webmcp-cli search.weibo -h`
   - `weibo-webmcp-cli search.ai.summary -h`
3. Check authentication state first when the profile is new or looks stale:
   - `weibo-webmcp-cli bridge.session.status`
   - `weibo-webmcp-cli auth.get`
   - if the session is not ready, start bootstrap or switch to headed:
     - `weibo-webmcp-cli bridge.session.bootstrap`
     - `weibo-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
     - `weibo-webmcp-cli bridge.open`
4. Use read tools for timeline, posts, and profiles:
   - `weibo-webmcp-cli timeline.home.list limit=10`
   - `weibo-webmcp-cli post.get '{"url":"https://weibo.com/123/detail/abcDEF"}'`
   - `weibo-webmcp-cli post.replies.list '{"id":"5279584255214211"}'`
   - `weibo-webmcp-cli post.repost.list '{"id":"5279584255214211"}'`
   - `weibo-webmcp-cli user.get screenName=jolestar`
   - `weibo-webmcp-cli user.posts.list '{"uid":"1648815335"}'`
5. Use search tools for public results and AI summaries:
   - `weibo-webmcp-cli search.weibo '{"query":"OpenAI","limit":10}'`
   - `weibo-webmcp-cli search.ai.summary '{"query":"OpenAI"}'`
6. Parse JSON output only:
   - success path: `.ok == true`, consume `.data`
   - failure path: `.ok == false`, inspect `.error.code` and `.error.message`

## Default Target

The built-in preset uses:

```bash
--site weibo
```

The default profile path is:

```bash
~/.uxc/webmcp-profile/weibo
```

Refresh the link with:

```bash
skills/weibo-webmcp/scripts/ensure-links.sh
```

## Guardrails

- Keep the Weibo profile isolated from other sites.
- Weibo uses `bootstrap_then_attach`; do not expect page tools to work until the managed profile is authenticated.
- The current Weibo skill is read-only. Do not imply posting, liking, following, or any other write operation.
- `timeline.home.list` is network-first but may warm templates in a dedicated read page; do not assume the currently visible tab is the one serving data.
- `search.weibo` uses server-rendered results with page-number pagination, not a stable public JSON results API.
- `search.ai.summary` can return structured status without a non-empty summary body. Treat `summary_unavailable` as a valid no-summary state, not an automatic failure.
- Prefer explicit `bridge.session.mode.set` over relaunching the command to change runtime mode.
- If the user closes the visible Weibo window manually, the headed owner session ends. Run `weibo-webmcp-cli bridge.open` again if you still need a visible session on the same profile.

## References

- Common command patterns:
  - `references/usage-patterns.md`
- Link creation helper:
  - `scripts/ensure-links.sh`
