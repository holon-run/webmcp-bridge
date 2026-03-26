# Manual Skill Smoke Tests

Date: 2026-03-24

This document preserves one manual verification run for:

- `skills/webmcp-bridge`
- `skills/board-webmcp`
- `skills/x-webmcp`
- `skills/google-webmcp`

The run used the repository-local `local-mcp` build instead of the published npm package.

## Environment

- repo: `webmcp-bridge`
- branch under test before documentation: `main`
- launcher: `node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js`
- `uxc`: `0.12.3`
- `node`: `v23.3.0`
- `pnpm`: `10.6.5`

Temporary link directories used in this run:

- `/tmp/webmcp-manual-links.1ZTliD`
- `/tmp/google-archived-links.t4D8HB`

Profiles used in this run:

- generic bridge test: `~/.uxc/webmcp-profile/board-manual`
- board skill test: `~/.uxc/webmcp-profile/board-manual-skill`
- X skill test: `~/.uxc/webmcp-profile/x`
- Google skill test: `~/.uxc/webmcp-profile/google`
- Google archived retry: `~/.uxc/webmcp-profile/google-archived-20260320-073848`

## Result Summary

- `webmcp-bridge`: pass
- `board-webmcp`: pass
- `x-webmcp`: pass
- `google-webmcp`: blocked by environment prerequisite

## 1. Generic `webmcp-bridge` Session Control

Purpose:
- verify one fixed generic link can start in `headless`
- verify `bridge.session.mode.set` switches `headless -> headed -> headless`
- verify `bridge.open` works only after the runtime is actually `headed`

Link setup:

```bash
WEBMCP_LOCAL_MCP_COMMAND='node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js' \
  skills/webmcp-bridge/scripts/ensure-links.sh \
  --name board-generic-manual \
  --url https://board.holon.run \
  --dir /tmp/webmcp-manual-links.1ZTliD \
  --profile ~/.uxc/webmcp-profile/board-manual
```

Commands:

```bash
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.session.status
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.session.mode.get
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.open
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.session.status
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.session.mode.set '{"mode":"headless"}'
/tmp/webmcp-manual-links.1ZTliD/board-generic-manual-webmcp-cli bridge.session.mode.get
```

Observed result:

- initial `bridge.session.status` returned `controlMode=launch`, `mode=native`, `presentationMode=headless`, `preferredPresentationMode=headless`
- `bridge.session.mode.set {"mode":"headed"}` returned `updated=true` and `presentationMode=headed`
- `bridge.open` returned `ok=true` with `windowState=focused`
- follow-up `bridge.session.status` returned `presentationMode=headed`, `preferredPresentationMode=headed`
- switching back with `bridge.session.mode.set {"mode":"headless"}` returned `presentationMode=headless`
- final `bridge.session.mode.get` returned `headless`

Conclusion:
- generic bridge session management worked as designed
- actual runtime mode tracking matched the new `presentationMode` contract

## 2. `board-webmcp` Native Tool Smoke

Purpose:
- verify the dedicated board skill creates the expected link
- verify native board tools work in `headless`
- verify the headed collaboration entrypoint still works

Link setup:

```bash
WEBMCP_LOCAL_MCP_COMMAND='node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js' \
  skills/board-webmcp/scripts/ensure-links.sh \
  --dir /tmp/webmcp-manual-links.1ZTliD \
  --profile ~/.uxc/webmcp-profile/board-manual-skill
```

Commands:

```bash
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli -h
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli bridge.session.status
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli nodes.list
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli diagram.get
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli bridge.session.status
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli bridge.open
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli selection.get
/tmp/webmcp-manual-links.1ZTliD/board-webmcp-cli bridge.close
```

Observed result:

- host help listed the expected bridge operations and board operations such as `diagram.get`, `nodes.list`, `edges.list`, `selection.get`
- initial status returned `mode=native`, `presentationMode=headless`
- `nodes.list` returned the expected demo graph with `summary.nodeCount=7`, `summary.edgeCount=7`
- `diagram.get` returned the expected structured document with title `Board WebMCP Demo`
- after `bridge.session.mode.set {"mode":"headed"}`, status returned `presentationMode=headed`
- `bridge.open` returned `ok=true` with `windowState=focused`
- `selection.get` returned an empty selection and the same `nodeCount=7`, `edgeCount=7` summary
- `bridge.close` returned `closing=true`

Operator note:

- a parallel trial of `bridge.session.mode.set {"mode":"headed"}` and `bridge.open` caused `bridge.open` to fail with `UNSUPPORTED_IN_HEADLESS_SESSION`
- that was expected because `bridge.open` ran before the mode switch completed
- the manual case should be executed sequentially: wait for `mode.set` to complete, then call `bridge.open`

Conclusion:
- the board skill worked for both headless automation and headed collaboration

## 3. `x-webmcp` Adapter Smoke

Purpose:
- verify the dedicated X skill creates the expected link
- verify X adapter reads and Grok chat work against an authenticated profile
- verify actual runtime state can differ from link defaults when the bridge reattaches to an existing managed session

Link setup:

```bash
WEBMCP_LOCAL_MCP_COMMAND='node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js' \
  skills/x-webmcp/scripts/ensure-links.sh \
  --dir /tmp/webmcp-manual-links.1ZTliD \
  --profile ~/.uxc/webmcp-profile/x
```

Commands:

```bash
/tmp/webmcp-manual-links.1ZTliD/x-webmcp-cli bridge.session.status
/tmp/webmcp-manual-links.1ZTliD/x-webmcp-cli auth.get
/tmp/webmcp-manual-links.1ZTliD/x-webmcp-cli timeline.home.list limit=3
/tmp/webmcp-manual-links.1ZTliD/x-webmcp-cli grok.chat '{"prompt":"Reply with exactly: webmcp bridge manual test ok","timeoutMs":180000}'
```

Observed result:

- `bridge.session.status` returned:
  - `authPolicyMode=bootstrap_then_attach`
  - `controlMode=attach`
  - `mode=adapter-shim`
  - `ownership=managed`
  - `presentationMode=headed`
  - `preferredPresentationMode=headed`
- this confirmed the recent presentation-mode behavior: the link default was `--headless`, but the live session reattached to an already headed managed browser
- `auth.get` returned `state=authenticated` with `signals=["authenticated_ui"]`
- `timeline.home.list limit=3` succeeded with `source=network`, populated `items`, and returned `hasMore=true`
- `grok.chat` succeeded with:
  - `ok=true`
  - `conversationId=2036251895245971636`
  - `response=webmcpbridgemanualtestok`
  - `url=https://x.com/i/grok?conversation=2036251895245971636`

Conclusion:
- X adapter reads and Grok chat both worked on this machine
- the run also validated that skill guidance should rely on actual `presentationMode`, not command-name intent

## 4. `google-webmcp` Adapter Smoke

Purpose:
- verify the dedicated Google skill creates the expected link
- verify the control plane correctly exposes bootstrap-only states
- verify the manual prerequisites required before Gemini tools become callable

Link setup:

```bash
WEBMCP_LOCAL_MCP_COMMAND='node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js' \
  skills/google-webmcp/scripts/ensure-links.sh \
  --dir /tmp/webmcp-manual-links.1ZTliD \
  --profile ~/.uxc/webmcp-profile/google
```

Commands attempted:

```bash
/tmp/webmcp-manual-links.1ZTliD/google-webmcp-cli bridge.session.status
/tmp/webmcp-manual-links.1ZTliD/google-webmcp-cli auth.get
/tmp/webmcp-manual-links.1ZTliD/google-webmcp-cli search.web '{"query":"webmcp bridge holon","limit":5}'
/tmp/webmcp-manual-links.1ZTliD/google-webmcp-cli gemini.chat '{"prompt":"Reply with exactly: webmcp bridge manual test ok","mode":"text","timeoutMs":180000}'
/tmp/webmcp-manual-links.1ZTliD/google-webmcp-cli bridge.session.attach
```

Observed result on the active Google profile:

- `bridge.session.status` returned:
  - `authPolicyMode=bootstrap_then_attach`
  - `controlMode=bootstrap`
  - `mode=control-only`
  - `ownership=external`
  - `sessionState=bootstrap_active`
  - `presentationMode=headed`
  - `authState=unknown`
- while in that bootstrap-only state, page tools were unavailable:
  - `auth.get` failed with `EXECUTION_FAILED`
  - `search.web` failed with `EXECUTION_FAILED`
  - `gemini.chat` failed with `EXECUTION_FAILED`
- `bridge.session.attach` initially failed with:
  - `BOOTSTRAP_BROWSER_CLOSE_TIMEOUT: timed out waiting for bootstrap browser 96394 to exit`
- after terminating that stale Chrome bootstrap process and retrying `bridge.session.attach`, the profile relaunched another headed bootstrap browser and remained in `bootstrap_active`

Archived profile retry:

```bash
WEBMCP_LOCAL_MCP_COMMAND='node /Users/jolestar/opensource/src/github.com/holon-run/webmcp-bridge/packages/local-mcp/dist/cli.js' \
  skills/google-webmcp/scripts/ensure-links.sh \
  --dir /tmp/google-archived-links.t4D8HB \
  --profile ~/.uxc/webmcp-profile/google-archived-20260320-073848

/tmp/google-archived-links.t4D8HB/google-webmcp-cli bridge.session.status
/tmp/google-archived-links.t4D8HB/google-webmcp-cli auth.get
```

Observed result on the archived profile:

- the archived profile also started in `controlMode=bootstrap`, `mode=control-only`, `sessionState=bootstrap_active`
- `auth.get` was unavailable there as well

Conclusion:

- this run did not complete a full Google adapter tool call because none of the tested Google profiles had completed Gemini bootstrap/auth on this machine
- the control plane behavior itself looked correct: bootstrap state was surfaced clearly, and page tools stayed unavailable until attach/auth completes
- this should be treated as an environment-precondition block, not as a confirmed `google-webmcp` adapter regression

Required follow-up to complete this manual case:

1. start `google-webmcp-cli bridge.session.bootstrap`
2. complete Gemini sign-in manually in the opened browser window
3. close that bootstrap browser window cleanly
4. rerun `google-webmcp-cli bridge.session.attach`
5. rerun:
   - `google-webmcp-cli auth.get`
   - `google-webmcp-cli search.web '{"query":"webmcp bridge holon","limit":5}'`
   - `google-webmcp-cli gemini.chat '{"prompt":"Reply with exactly: webmcp bridge manual test ok","mode":"text","timeoutMs":180000}'`
