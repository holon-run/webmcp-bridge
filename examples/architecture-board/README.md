# architecture-board

Native WebMCP example app for `webmcp-bridge`.

This example is not an adapter. It is a browser app that exposes `navigator.modelContext` directly and lets a human and an AI edit the same architecture diagram together.

## Run

```bash
pnpm install
pnpm --filter @webmcp-bridge/example-architecture-board dev
```

The app serves on `http://127.0.0.1:4173`.

## Connect From local-mcp

```bash
node packages/local-mcp/dist/cli.js --url http://127.0.0.1:4173 --headless
```

## MVP Tools

- `nodes.list`
- `nodes.upsert`
- `edges.list`
- `edges.upsert`
- `layout.apply`
- `diagram.export`

## Notes

- Diagram state persists in browser `localStorage`.
- The page provides its own `navigator.modelContext` implementation so it also works in standard browsers.
- This example demonstrates a native WebMCP provider; it does not use `adapter-*`.
