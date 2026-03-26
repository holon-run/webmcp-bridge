# webmcp-bridge

`webmcp-bridge` connects local MCP clients to website tools in the browser.

It is native-first:

- if a site exposes browser WebMCP, the bridge calls it directly
- if a site does not, the bridge falls back to a thin site adapter

## Start Here

- [Getting Started](./getting-started/)
- [CLI And Control Plane](./reference/cli.md)
- [Bridge Session Model](./reference/session-lifecycle.md)
- [Architecture](./reference/architecture.md)
- [Adapters](./adapters/)
- [Skills](./skills/)

## What Is In The Repo

- `@webmcp-bridge/local-mcp`: one-site stdio MCP server
- `@webmcp-bridge/playwright`: page gateway and browser lifecycle layer
- `@webmcp-bridge/adapter-x`: X fallback adapter
- `@webmcp-bridge/adapter-google`: Google and Gemini fallback adapter
- `@webmcp-bridge/adapter-weibo`: Weibo fallback adapter
- `@webmcp-bridge/core`: shared shim and runtime contracts
- `examples/board`: native WebMCP example app

## Use Policy

This project is for WebMCP research, development, testing, and normal user-authorized browser workflows.

It is not intended for unauthorized data collection, bulk scraping, access-control bypass, or abusive automation against third-party services. Operators are responsible for complying with applicable laws, platform rules, and website terms.

## Reader Paths

### I want to connect one site quickly

Go to [Getting Started](./getting-started/).

### I only see `bridge.*` tools and do not know what to do

Go to [Bridge Session Model](./reference/session-lifecycle.md). That page explains bootstrap, attach, `presentationMode`, and bridge-only recovery.

### I want to understand the architecture

Go to [Architecture](./reference/architecture.md).

### I want to operate X, Gemini, or Weibo

Go to [Adapters](./adapters/).

### I want to install agent skills

Go to [Skills](./skills/).

<!-- INDEX:START -->

- [Adapters](./adapters/)
- [Getting Started](./getting-started/)
- [Reference](./reference/)
- [Skills](./skills/)
- [Tests And Validation](./tests/)

<!-- INDEX:END -->
