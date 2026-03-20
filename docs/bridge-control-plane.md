# Bridge Control Plane

`local-mcp` needs two different classes of built-in controls:

- controls for the current browser runtime and window owned by the current stdio process;
- controls for the longer-lived site session/profile lifecycle that may outlive one runtime.

This document defines the reserved local control namespace and the next-step lifecycle model for auth-sensitive sites.

## Problem

Today `local-mcp` injects built-in tools like `bridge.open` and `bridge.close` beside page tools.
That works for simple window control, but it does not scale well to richer lifecycle actions such as:

- bootstrap a normal browser for manual sign-in;
- attach to an already running browser;
- inspect current profile/session state;
- reset or rebuild a managed profile.

Using top-level names such as `session.*` would also collide with future site-provided WebMCP tools.

## Decision

All local built-in controls stay under the reserved `bridge.*` namespace.

Current split:

- `bridge.window.*`
  - controls the current runtime window only.
- `bridge.session.*`
  - controls the current local-mcp session/control-plane state.

Backward compatibility:

- `bridge.open` remains as a legacy alias for `bridge.window.open`
- `bridge.close` remains as a legacy alias for `bridge.session.stop`

This keeps existing clients working while making the reserved namespace explicit.

## Current Control Plane

Implemented in this refactor:

- `bridge.window.open`
- `bridge.session.status`
- `bridge.session.stop`
- legacy aliases: `bridge.open`, `bridge.close`

`bridge.session.status` currently reports the runtime-scoped session view:

- `site`
- `targetUrl`
- `controlMode` (`launch` | `attach`)
- `mode` (`native` | `polyfill` | `adapter-shim`)
- `headless`

This is intentionally small. It is enough to let clients distinguish local control-plane state from page tools without prematurely committing to a profile metadata format.

## Future Lifecycle Model

For auth-sensitive sites, the long-term target is:

1. `bootstrap`
   - launch a normal browser pointed at the managed profile
   - no Playwright-owned login flow
   - user completes sign-in manually
2. `attach`
   - restart in attach mode against the same profile/browser
   - Playwright controls the authenticated browser after sign-in

This implies a future session state machine roughly like:

- `profile_missing`
- `profile_present_unverified`
- `auth_required`
- `challenge_required`
- `authenticated`
- `attachable`

The control-plane namespace leaves room for future methods such as:

- `bridge.session.bootstrap`
- `bridge.session.attach`
- `bridge.session.restart`
- `bridge.session.reset_profile`

## Adapter Direction

The bridge control plane should stay generic and site-agnostic.
Site-specific auth behavior should continue to come from adapter manifests and adapter tools.

Likely future adapter-facing shape:

```ts
type AuthPolicy = {
  mode: "none" | "bootstrap_then_attach";
  authProbeTool?: string;
  allowAnonymousTools?: boolean;
};
```

Runtime-facing browser control remains separate:

```ts
type BrowserControlMode = "launch" | "attach";
```

This separation keeps:

- adapter manifests responsible for auth sensitivity;
- local-mcp responsible for browser/session orchestration;
- `bridge.*` responsible for local control-plane operations only.
