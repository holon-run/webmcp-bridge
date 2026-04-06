# Bridge Session Model

The bridge has two different responsibilities:

- current browser runtime and window control
- longer-lived site session and profile control

That is why `bridge.window.*` and `bridge.session.*` both exist.

## Lifecycle States

Important session concepts:

- `controlMode`: `none`, `bootstrap`, `launch`, or `attach`
- `mode`: `native`, `polyfill`, `adapter-shim`, `overlay-bootstrap`, or `control-only`
- `presentationMode`: `headed` or `headless`
- `ownership`: `managed` or `external`
- `sessionState`: profile/auth/runtime state for the current site profile

## Auth-Sensitive Sites

For sites such as X and Google, the bridge can run in `bootstrap_then_attach` mode:

1. open a normal headed browser for manual sign-in
2. reuse the same profile
3. attach over CDP for automation

Bootstrap is always headed.

## When Only `bridge.*` Tools Are Visible

If `<site>-webmcp-cli -h` only lists `bridge.*`, the bridge is alive but page tools are not ready yet.

Use this order:

```bash
<site>-webmcp-cli bridge.session.status
```

Then choose one of these:

- if auth is incomplete:

```bash
<site>-webmcp-cli bridge.session.bootstrap
```

- if the profile should already be usable and needs page reattachment:

```bash
<site>-webmcp-cli bridge.session.attach
```

- if human recovery needs a visible browser:

```bash
<site>-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
<site>-webmcp-cli bridge.open
```

Only call site operations after help output shows site tools again.

For adapterless pages, `bridge.session.status` may report `mode=overlay-bootstrap`.
That means the browser runtime is alive, but there are no native or formal adapter tools yet.
Use:

```bash
<site>-webmcp-cli bridge.debug.eval '{"script":"() => document.title"}'
<site>-webmcp-cli bridge.overlay.install '{"id":"draft","tools":[{"name":"page.title.get","script":"() => ({ title: document.title })"}]}'
```

After install succeeds, rerun help and the overlay tool will appear as `overlay.draft.page.title.get`.

## Managed vs External

Managed sessions:

- can switch with `bridge.session.mode.set`
- can open a new visible browser with `bridge.open`

External attach sessions:

- are attached to an existing external browser
- cannot be mode-switched by the bridge

## Recommended Habit

Do not assume the command name implies the current runtime state.

Always verify with:

```bash
<site>-webmcp-cli bridge.session.status
```
