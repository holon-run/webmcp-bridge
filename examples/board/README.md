# board

Native WebMCP example app for `webmcp-bridge`.

This example is not an adapter. It is a browser app that exposes `navigator.modelContext` directly and lets a human and an AI edit the same diagram together.

## Run

```bash
pnpm install
pnpm --filter @webmcp-bridge/example-board dev
```

The app serves on `http://127.0.0.1:4173`.

## Deploy

Cloudflare Pages is the intended deployment target for the public demo at `https://board.holon.run`.

```bash
pnpm --filter @webmcp-bridge/example-board build
pnpm --filter @webmcp-bridge/example-board deploy:pages
```

The Pages project name is pinned as `board` in [wrangler.jsonc](/Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/examples/board/wrangler.jsonc).

## Connect From local-mcp

Architecture overview:

![Bridge architecture](../../docs/images/bridge-architecture.png)

Public deployment:

```bash
node packages/local-mcp/dist/cli.js --url https://board.holon.run --headless
```

Local development:

```bash
node packages/local-mcp/dist/cli.js --url http://127.0.0.1:4173 --headless
```

Reveal the shared headed browser session before live collaboration:

```bash
board-webmcp-ui bridge.open
```

If the user closes that window manually, run `board-webmcp-ui bridge.open` again to reopen the page in the same headed session.

## Collaborate With AI

This demo is meant to be edited by a human in the browser while an AI edits the same board through `local-mcp`.

Typical flow in Codex / Claude Code:

1. Open a visible board session:

   ```bash
   board-webmcp-ui bridge.open
   ```

2. Read the current board state:

   ```bash
   board-webmcp-cli diagram.get
   board-webmcp-cli nodes.list
   board-webmcp-cli edges.list
   ```

3. Let the human select or move content in the page, then let the AI inspect or update it:

   ```bash
   board-webmcp-ui selection.get
   board-webmcp-ui selection.remove
   board-webmcp-cli nodes.upsert '{"nodes":[{"id":"idea","label":"New Idea","kind":"service","x":480,"y":220}]}'
   board-webmcp-cli edges.upsert '{"edges":[{"id":"idea-link","sourceNodeId":"uxc","targetNodeId":"idea","label":"draft"}]}'
   board-webmcp-cli layout.apply mode=layered
   ```

4. When the user closes the visible window manually, reopen it:

   ```bash
   board-webmcp-ui bridge.open
   ```

Useful collaboration tools:

- `bridge.open` / `bridge.close`
- `diagram.get` / `diagram.loadDemo` / `diagram.setTitle`
- `selection.get` / `selection.remove`
- `nodes.*`
- `edges.*`
- `layout.apply`
- `view.fit`

## WebMCP Tools

- `nodes.list`
- `nodes.upsert`
- `nodes.style`
- `nodes.resize`
- `nodes.remove`
- `edges.list`
- `edges.upsert`
- `edges.style`
- `edges.remove`
- `layout.apply`
- `canvas.style`
- `view.fit`
- `diagram.get`
- `diagram.setTitle`
- `diagram.loadDemo`
- `diagram.reset`
- `diagram.export`
- `selection.get`
- `selection.remove`

## Notes

- Diagram state persists in browser `localStorage`.
- The default diagram title is `Board WebMCP Demo`, and `diagram.setTitle` updates the exported filename/title metadata.
- The page provides its own `navigator.modelContext` implementation so it also works in standard browsers.
- This example demonstrates a native WebMCP provider; it does not use `adapter-*`.
