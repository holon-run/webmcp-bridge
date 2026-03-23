---
name: webmcp-adapter-creator
description: Create fallback site adapters for websites that do not expose native WebMCP. Use when a site needs a new adapter module, tool schema design, browser-side request execution, or request-template extraction from observed page behavior.
---

# WebMCP Adapter Creator

Use this skill to create or update a fallback `SiteAdapter` for `@webmcp-bridge/local-mcp`.

## When To Use

Use this skill when:

- the target site does not expose native `navigator.modelContext`
- an existing adapter does not exist yet
- an existing adapter needs new tools, pagination, or request-template refresh
- a site requires browser-side request execution instead of DOM-only scraping

If the user only needs to connect to an existing site through the bridge, use `$webmcp-bridge` instead.

## Prerequisites

- The target site URL is known.
- The user can authenticate in the browser profile if the site requires login.
- `pnpm` is installed for local package work.
- `npx playwright install` has already been run in the current environment when Playwright browsers are not present.

## Core Workflow

1. Confirm the site really needs a fallback adapter:
   - check whether native `navigator.modelContext` already exists
   - if native WebMCP exists, stop and use `$webmcp-bridge` instead of writing an adapter
2. Scaffold a new adapter package when starting from scratch:
   - `skills/webmcp-adapter-creator/scripts/scaffold-adapter.sh --name <site> --host <host> --url <url>`
3. Fix the contract first:
   - implement `manifest`
   - implement `createAdapter()`
   - keep all payloads JSON-serializable
4. Design the tool surface before coding extraction logic:
   - use stable product names such as `tweet.get`, `timeline.home.list`, `user.get`
   - put parameter details in schema field descriptions, not only in tool descriptions
5. Prefer browser-side request execution over server-side credential replay:
   - run requests in the page context so the site's own auth/session state is reused
   - do not move cookies or bearer tokens into local-mcp
6. Discover stable request templates from real page behavior:
   - trigger the target action in the page
   - observe the network request shape
   - extract a reusable request template with placeholders for ids, cursors, queries, or feature flags
7. Implement fallback layers explicitly:
   - first try browser-side network/template execution
   - for assistant/chat products, prefer intercepting the product's real request/response path over reading rendered text
   - if network execution is unavailable or the template is missing, fall back to DOM extraction when safe
   - include `source` and `reason` fields so callers can see which path ran
   - when a helper is cross-site and not product-specific, prefer putting it in a shared adapter utility package instead of copying it into one adapter
   - for long prompts, prefer one-shot DOM insertion into the real composer and use incremental `type()` or `fill()` only as a fallback
   - when waiting for chat/image completion, use activity-aware idle deadlines instead of a fixed wall-clock timeout
   - activity signals may include stop controls, response fingerprint changes, feedback buttons, or generated image count changes
   - compare against a normalized snapshot of the previous response before declaring a new answer ready
   - do not reset or reopen the page during fallback confirmation if that would lose the current conversation/session context
8. Add contract and integration coverage:
   - package-local unit tests for tool behavior and validation
   - local-mcp integration tests for full bridge execution
   - cover long prompt insertion, long-thinking waits, stale-response misdetection, and session-preserving fallback paths

## Guardrails

- Keep site logic inside the adapter package only.
- Fail closed on ambiguous upstream states such as `AUTH_REQUIRED`, `UPSTREAM_CHANGED`, and `CHALLENGE_REQUIRED`.
- Prefer stable request templates over brittle DOM-only scraping for authenticated data reads.
- Do not add credential vaulting, secret replay, or auth bypass logic.
- The browser page is the execution environment for privileged site actions.

## References

- End-to-end adapter creation flow:
  - `references/workflow.md`
- How to discover requests from page behavior:
  - `references/network-discovery.md`
- How to turn captured requests into reusable templates:
  - `references/request-template-patterns.md`
- Runtime patterns for streamed responses, request interception, and session-aware tools:
  - `references/adapter-runtime-patterns.md`
- Testing expectations for adapter packages:
  - `references/testing.md`
- Adapter scaffold helper:
  - `scripts/scaffold-adapter.sh`
