# Bridge Control Plane

`local-mcp` needs two different classes of built-in controls:

- controls for the current browser runtime and window owned by the current stdio process;
- controls for the longer-lived site session/profile lifecycle that may outlive one runtime.

This document defines the reserved local control namespace and the current lifecycle model for auth-sensitive sites.

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

Implemented in the current control plane:

- `bridge.window.open`
- `bridge.session.status`
- `bridge.session.bootstrap`
- `bridge.session.attach`
- `bridge.session.restart`
- `bridge.session.stop`
- `bridge.session.reset_profile`
- legacy aliases: `bridge.open`, `bridge.close`

`bridge.session.status` reports the local session view, not only the active runtime:

- `site`
- `targetUrl`
- `controlMode` (`none` | `bootstrap` | `launch` | `attach`)
- `browserUrl` (when an attached browser is known)
- `mode` (`native` | `polyfill` | `adapter-shim` | `control-only`)
- `headless`
- `authPolicyMode` (`none` | `bootstrap_then_attach`)
- `authState` (`unknown` | `authenticated` | `auth_required` | `challenge_required`)
- `sessionState`
  - `profile_missing`
  - `profile_present_unverified`
  - `bootstrap_active`
  - `auth_required`
  - `challenge_required`
  - `authenticated`
  - `runtime_active`
- `ownership` (`none` | `managed` | `external`)
- `profilePath` (for managed-profile sessions)
- `browserPid` (for a managed browser when known)
- `lastBackupPath` (after `bridge.session.reset_profile`)

`bridge.session.bootstrap`, `bridge.session.attach`, `bridge.session.restart`, and
`bridge.session.reset_profile` are the executable lifecycle controls:

- `bridge.session.bootstrap`
  - for auth-sensitive managed sessions only
  - launches a normal browser with the managed profile
  - does not use Playwright launch for the sign-in flow
- `bridge.session.attach`
  - attaches to an explicit external browser when `browserUrl` is provided
  - otherwise, for auth-sensitive managed sessions, launches a managed attach browser and connects over CDP
- `bridge.session.restart`
  - restarts the current bridge runtime in place
  - supported for standard launch/attach sessions
  - rejected for `bootstrap_then_attach` sessions when the requested mode is `launch`
- `bridge.session.reset_profile`
  - backs up the managed profile
  - recreates an empty managed profile
  - for auth-sensitive sessions, immediately re-enters bootstrap mode

## Session Metadata

Managed auth-sensitive sessions persist lightweight metadata beside the profile so the
next `local-mcp` process can decide whether to:

- bootstrap a normal browser for manual sign-in
- reattach to an existing managed attach browser
- start a fresh managed attach browser after a previous authenticated bootstrap

The metadata records:

- site id and target URL
- auth policy mode and auth probe tool
- session state and auth state
- current control mode
- ownership (`managed` or `external`)
- managed attach `browserUrl` and `browserPid` when present
- latest backup path after profile reset

This metadata is intentionally local to `local-mcp`. It is not a daemon protocol and it
does not attempt to own browser processes started by `uxc` or by the user outside the
current control path.

## Lifecycle Model

For auth-sensitive sites, the active lifecycle is:

1. `bootstrap`
   - launch a normal browser pointed at the managed profile
   - no Playwright-owned login flow
   - user completes sign-in manually
2. `attach`
   - attach in CDP mode against the same profile/browser
   - Playwright controls the authenticated browser after sign-in

This uses the following state machine:

- `profile_missing`
- `profile_present_unverified`
- `bootstrap_active`
- `auth_required`
- `challenge_required`
- `authenticated`
- `runtime_active`

Startup decision for `authPolicy.mode = "bootstrap_then_attach"`:

1. If an explicit `--browser-url` is provided, attach to that browser.
2. Else if session metadata points to a running managed attach browser, reattach to it.
3. Else if metadata says the managed profile is already authenticated, launch a managed attach browser and attach.
4. Else launch bootstrap mode and wait for manual sign-in.

## Adapter Direction

The bridge control plane should stay generic and site-agnostic.
Site-specific auth behavior should continue to come from adapter manifests and adapter tools.

Current adapter-facing shape:

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
