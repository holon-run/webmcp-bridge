# Adapters

Adapters are the fallback path for sites that do not expose native browser WebMCP.

They are used only when native WebMCP is unavailable.

## Built-In Adapters

- [Fixture](./fixture.md)
- [X](./x.md)
- [Google And Gemini](./google.md)
- [Weibo](./weibo.md)

## Adapter Rules

- browser-side execution first
- fail closed on auth or ambiguous state
- keep tool payloads JSON-serializable
- keep site-specific behavior out of shared bridge packages
- use adapters only for research, development, testing, and normal authorized user workflows
- do not treat repository-provided adapters as a bulk-collection or bypass toolkit

## Creating New Adapters

This repo also includes a dedicated authoring workflow:

- [Skills](../skills/) for `webmcp-adapter-creator`

<!-- INDEX:START -->

- [Adapter: Fixture](./fixture.md)
  `@webmcp-bridge/adapter-fixture` is a deterministic fallback adapter for integration and contract tests.
  <!-- mdorigin:index kind=article -->

- [Adapter: Google And Gemini](./google.md)
  `@webmcp-bridge/adapter-google` handles Google and Gemini fallback automation when native WebMCP is unavailable.
  <!-- mdorigin:index kind=article -->

- [Adapter: Weibo](./weibo.md)
  `@webmcp-bridge/adapter-weibo` supports Weibo when native browser WebMCP is unavailable.
  <!-- mdorigin:index kind=article -->

- [Adapter: X](./x.md)
  `@webmcp-bridge/adapter-x` supports X and Twitter when native WebMCP is unavailable.
  <!-- mdorigin:index kind=article -->

<!-- INDEX:END -->
