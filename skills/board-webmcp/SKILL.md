---
name: board-webmcp
description: Connect to the native board demo through local-mcp and one fixed UXC link. Use when the user wants to inspect or edit the shared board at board.holon.run or a local board instance through browser WebMCP.
---

# Board WebMCP

Use this skill to operate the native board demo through `@webmcp-bridge/local-mcp`.

## Prerequisites

- `uxc` is installed and available in `PATH`.
- `npx` is installed and available in `PATH`.
- Network access to `https://board.holon.run`.
- On a fresh machine, or under an isolated `HOME`, install Playwright browsers first with `npx playwright install`.
- For local board development, point the setup script at `http://127.0.0.1:4173`.

## Core Workflow

1. Ensure the fixed board link exists:
   - `command -v board-webmcp-cli`
   - if missing or pointed at the wrong URL, run `skills/board-webmcp/scripts/ensure-links.sh`
2. Inspect the bridge and tool schema before calling tools:
   - `board-webmcp-cli -h`
   - `board-webmcp-cli nodes.list -h`
   - `board-webmcp-cli nodes.upsert -h`
3. Read current board state:
   - non-collaborative automation: `board-webmcp-cli nodes.list`, `board-webmcp-cli edges.list`
   - collaborative visible session:
     - `board-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
     - `board-webmcp-cli bridge.open`
     - `board-webmcp-cli nodes.list`
     - `board-webmcp-cli edges.list`
4. Apply updates with structured inputs:
   - `board-webmcp-cli diagram.export format=json`
   - collaborative visible session should keep the same runtime in `headed`
   - `board-webmcp-cli nodes.upsert '{"nodes":[{"label":"Fraud Service","kind":"service"}]}'`
   - `board-webmcp-cli edges.upsert '{"edges":[{"sourceNodeId":"gateway","targetNodeId":"orders","protocol":"grpc"}]}'`
   - `board-webmcp-cli layout.apply mode=layered`
   - `board-webmcp-cli diagram.export format=json`
5. When a human is editing or reviewing the same board live:
   - check current state with `board-webmcp-cli bridge.session.status`
   - if needed, switch to headed with `board-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'`
   - `board-webmcp-cli bridge.open`
   - keep all reads and writes on `board-webmcp-cli` for that same collaborative session
   - `board-webmcp-cli selection.get`
   - `board-webmcp-cli bridge.close`
   - if the human closed the board window manually, the headed owner session has ended; run `board-webmcp-cli bridge.open` again to start a new headed session on the same profile

## Default Target

The default public target is:

```bash
https://board.holon.run
```

The default board profile path is:

```bash
~/.uxc/webmcp-profile/board
```

Use the helper script to refresh the link for the public deployment:

```bash
skills/board-webmcp/scripts/ensure-links.sh
```

Use the helper script to point the link at local development instead:

```bash
skills/board-webmcp/scripts/ensure-links.sh --url http://127.0.0.1:4173
```

If the bridge fails to start on a fresh machine or inside an isolated `HOME`, install Playwright browsers in that environment first:

```bash
npx playwright install
```

## Guardrails

- `board.holon.run` is a shared demo. Writes are visible on the board surface and persisted in browser storage for that profile.
- Prefer explicit `bridge.session.mode.set` over relying on a new launcher invocation to change runtime mode.
- Before collaborative editing, confirm the runtime is actually `headed`.
- If the human closes that window manually, the headed owner session ends. The next `board-webmcp-cli bridge.open` starts a new headed session on the same profile.
- Keep the board profile isolated from other sites.
- Use JSON output for automation. Do not depend on human-formatted text output.

## References

- Common command patterns:
  - `references/usage-patterns.md`
- Link creation helper:
  - `scripts/ensure-links.sh`
