## Board Scene-First Refactor Plan

### Status

`examples/board` currently maintains two independent state models:

1. Excalidraw scene state
2. Custom `DiagramStore` structured state

The bridge tools (`nodes.*`, `edges.*`, `layout.*`) update `DiagramStore`, and the React app projects that state into Excalidraw via `updateScene()`.

At the same time, Excalidraw `onChange()` is interpreted back into `DiagramStore`.

This creates a dual-source-of-truth system:

- `store -> scene`
- `scene -> store`

That design is the root cause of the current class of bugs:

- stale scene overwriting fresh tool updates
- deleted nodes reappearing
- scene element count diverging from store node count
- whiteboard not repainting even though the sidebar summary updates
- repeated timing/viewport patches around `updateScene()`

### Problem Statement

For users, the meaningful artifact is the final whiteboard, not an internal structured model.

For `examples/board`, the Excalidraw scene is the real product state.

The current `DiagramStore` is an adapter model we invented to make the first WebMCP MVP easier. It is useful for tool contracts, but it should not compete with Excalidraw scene as a second authoritative state.

### Target Architecture

Refactor `examples/board` to make Excalidraw scene the only authoritative state.

Target model:

- source of truth: Excalidraw scene
- persistence: serialized Excalidraw scene in `localStorage`
- UI: reads directly from scene
- WebMCP tools: read/write scene, not `DiagramStore`
- derived summaries: computed from scene on demand

This changes the data flow to:

- `tool call -> Excalidraw scene`
- `user edit -> Excalidraw scene`
- `scene -> derived summary/export/query`

There should no longer be a persistent competing structured store.

### Design Principles

1. Single source of truth
   - Excalidraw scene owns persisted board state.

2. Derived structure, not stored structure
   - `nodes.list` / `edges.list` can still exist, but they should be computed from scene metadata.

3. Excalidraw-first editing
   - Programmatic updates should use Excalidraw-compatible scene element creation/update.
   - User edits should persist automatically because they already mutate the scene.

4. Stable tool contract
   - Keep current MCP tool names for MVP continuity where possible.
   - Reimplement them over scene state instead of `DiagramStore`.

### Recommended Scene Model

Persist a single scene payload in `localStorage`, for example:

```ts
type BoardSceneSnapshot = {
  version: 1;
  elements: unknown[];
  appState?: {
    viewBackgroundColor?: string;
    scrollX?: number;
    scrollY?: number;
    zoom?: number;
  };
};
```

Notes:

- Persist only the scene fields needed to restore the board reliably.
- Do not persist a second normalized graph model as authoritative state.
- Keep bridge metadata on scene elements via `customData` / stable ids so tools can still address nodes and edges semantically.

### Tool Strategy

Keep the existing tool surface for MVP:

- `nodes.list`
- `nodes.upsert`
- `nodes.remove`
- `edges.list`
- `edges.upsert`
- `edges.remove`
- `layout.apply`
- `diagram.reset`
- `diagram.export`

But change their implementation:

#### `nodes.list`

Derive node records by scanning scene elements:

- rectangle/diamond/ellipse elements marked as bridge nodes
- extract:
  - `id`
  - `label`
  - `kind`
  - `x/y`
  - `width/height`

#### `nodes.upsert`

Modify or create scene elements directly:

- locate node element by stable bridge id
- update geometry and label in-place
- create new node scene element when absent

Do not update a separate `DiagramStore`.

#### `nodes.remove`

Delete corresponding scene elements directly:

- remove node element
- remove bound text / label if separate
- remove connected bridge edges

#### `edges.list`

Derive edges from scene arrow elements with bridge metadata.

#### `edges.upsert`

Create/update arrow scene elements directly, using official Excalidraw linear element skeletons with `label` where needed.

#### `edges.remove`

Delete matching arrow elements from scene.

#### `layout.apply`

Operate over derived node records, then write new coordinates back into the scene elements.

#### `diagram.reset`

Replace the scene with an empty scene snapshot.

#### `diagram.export`

Continue using Excalidraw export APIs.

### UI Refactor

#### Remove

- `DiagramStore` as authoritative state
- `sceneElementsToDocument(...); store.setDocument(...)` full reverse-sync loop
- document persistence via `DiagramStore`

#### Replace with

- `sceneSnapshot` state
- Excalidraw `onChange()` persisting current scene snapshot directly
- summary sidebar derived from current scene snapshot
- selection sidebar derived from current Excalidraw selection

### Migration Plan

#### Phase 1: Scene persistence

1. Introduce scene snapshot persistence in `localStorage`
2. Load initial scene from persisted snapshot
3. Keep existing `DiagramStore` temporarily only as a compatibility layer

Goal:

- board survives reload purely through Excalidraw scene persistence

#### Phase 2: Tool reimplementation over scene

1. Reimplement `nodes.*` and `edges.*` against scene elements
2. Keep return payloads unchanged
3. Stop writing authoritative updates into `DiagramStore`

Goal:

- MCP tools and visible board operate on the same state

#### Phase 3: Remove reverse full-sync

1. Delete `scene -> DiagramStore` full conversion path
2. Delete timing-based stale-scene guards that exist only because of dual authority

Goal:

- remove the stale overwrite class of bugs entirely

#### Phase 4: Remove `DiagramStore`

1. Replace summary derivation with scene-based helpers
2. Replace selection state with scene/appState-derived helpers
3. Delete:
   - `src/model.ts`
   - `src/state.ts`
   - store-specific tests

Goal:

- one state model only

### Compatibility Notes

This refactor should preserve the public board demo behavior:

- same URL
- same visible tools
- same MCP method names

The main change is internal:

- tools and UI will finally operate on the same underlying state

### Risks

1. Scene-to-graph derivation complexity
   - We still need a robust way to recognize bridge nodes and bridge edges from scene elements.

2. Programmatic element creation
   - We should stay within officially supported Excalidraw skeleton formats.

3. Selection/metadata stability
   - Stable ids and `customData` must survive scene round-trips.

4. Layout over scene
   - Layout code currently assumes a normalized node list.
   - It will need a scene-derived adapter layer.

### Non-Goals

This refactor should not attempt to turn `examples/board` into a full generic Excalidraw editor.

Still out of scope:

- arbitrary Excalidraw feature parity
- full styling round-trip for every element type
- freehand drawing semantics in MCP tools
- collaborative networking / multi-user sync

### Immediate Next Step

Start with Phase 1 and Phase 2 together:

1. add scene snapshot persistence
2. implement scene-derived `nodes.list`
3. implement scene-driven `nodes.upsert` / `nodes.remove`
4. keep `edges.*` temporarily on current bridge metadata, but move their source of truth to scene as well

This should eliminate the current `store/document` vs `scene` divergence before any further polish work.
