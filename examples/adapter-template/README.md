# adapter-template

Minimal third-party adapter module for `webmcp-local-mcp --adapter-module`.

## Build

```bash
pnpm --filter @webmcp-bridge/example-adapter-template build
```

## Run with local-mcp

```bash
node packages/local-mcp/dist/cli.js \
  --adapter-module ./examples/adapter-template/dist/index.js \
  --headless
```

## Expected tools

- `auth.get`
- `echo.execute`
