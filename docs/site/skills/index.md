# Skills

The repo publishes five agent skills.

## Site Skills

- `webmcp-bridge`
  General bridge operations, link creation, and session management.
- `board-webmcp`
  Wrapper skill for the native board demo.
- `x-webmcp`
  Wrapper skill for X, Grok, and X Articles.
- `google-webmcp`
  Wrapper skill for Google and Gemini.

## Authoring Skill

- `webmcp-adapter-creator`
  Workflow for creating new site adapters.

## Install

From ClawHub:

```bash
clawhub install uxc
clawhub install webmcp-bridge
clawhub install board-webmcp
clawhub install x-webmcp
clawhub install google-webmcp
clawhub install webmcp-adapter-creator
```

## Browse The Repository Skills Directory

The site also exposes the live repository `skills/` directory through a symlink, so the docs site can point at the real maintained files instead of a copied snapshot.

- [Repository Skills Directory](./repo/)

## Important Runtime Rule

Site wrapper commands such as `x-webmcp-cli` and `google-webmcp-cli` do not guarantee that page tools are already attached.

When only bridge tools are visible, use the recovery flow in:

- [Bridge Session Model](../reference/session-lifecycle.md)

<!-- INDEX:START -->

- [Repository Skills](./repo/)

<!-- INDEX:END -->
