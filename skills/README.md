# Repository Skills

This directory contains the skills that are maintained in this repository.

## Published Skills

- `webmcp-bridge`
  General bridge operations, per-site links, and browser session management.
- `board-webmcp`
  Site wrapper for the native board demo.
- `x-webmcp`
  Site wrapper for X, Grok, and X Articles flows.
- `google-webmcp`
  Site wrapper for Google and Gemini flows.
- `webmcp-adapter-creator`
  Workflow for creating new fallback site adapters.

## Directory Layout

Each skill usually contains:

- `SKILL.md`
  The main skill contract and workflow.
- `agents/`
  Agent-specific metadata.
- `references/`
  Supporting usage, troubleshooting, and workflow notes.
- `scripts/`
  Helper scripts for validation or link creation.

## Maintenance Notes

- Edit the real files in this directory, not generated copies.
- Run the corresponding `scripts/validate.sh` file before publishing a changed skill.
- Publish changed skills through ClawHub from the repository root.

<!-- INDEX:START -->

- [board-webmcp](./board-webmcp/)
  Connect to the native board demo through local-mcp and one fixed UXC link. Use when the user wants to inspect or edit the shared board at board.holon.run or a local board instance through browser WebMCP.

- [google-webmcp](./google-webmcp/)
  Connect to Google Search and Gemini through the built-in local-mcp Google adapter and one fixed UXC link. Use when the user wants to run Google searches, chat with Gemini, or download generated Gemini images from an authenticated browser profile.

- [webmcp-adapter-creator](./webmcp-adapter-creator/)
  Create fallback site adapters for websites that do not expose native WebMCP. Use when a site needs a new adapter module, tool schema design, browser-side request execution, or request-template extraction from observed page behavior.

- [webmcp-bridge](./webmcp-bridge/)
  Connect a website to the local-mcp browser bridge through a fixed UXC link. Use when the user needs to operate native WebMCP sites or adapter-backed sites through local-mcp, manage per-site browser profiles, or switch bridge presentation modes explicitly.

- [x-webmcp](./x-webmcp/)
  Connect to X and Grok through the built-in local-mcp X adapter and one fixed UXC link. Use when the user wants to read timelines, inspect tweets, post on X, or chat with Grok from an authenticated browser profile.

<!-- INDEX:END -->
