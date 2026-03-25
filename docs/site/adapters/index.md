# Adapters

Adapters are the fallback path for sites that do not expose native browser WebMCP.

They are used only when native WebMCP is unavailable.

## Built-In Adapters

- [X](./x.md)
- [Google And Gemini](./google.md)

## Adapter Rules

- browser-side execution first
- fail closed on auth or ambiguous state
- keep tool payloads JSON-serializable
- keep site-specific behavior out of shared bridge packages

## Creating New Adapters

This repo also includes a dedicated authoring workflow:

- [Skills](../skills/) for `webmcp-adapter-creator`

<!-- INDEX:START -->

- [Adapter: Google And Gemini](./google.md)
  `@webmcp-bridge/adapter-google` handles Google and Gemini fallback automation when native WebMCP is unavailable.

- [Adapter: X](./x.md)
  `@webmcp-bridge/adapter-x` supports X and Twitter when native WebMCP is unavailable.

<!-- INDEX:END -->
