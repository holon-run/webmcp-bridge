/**
 * This module stores the authoritative Excalidraw scene snapshot and ephemeral selection for the board example.
 * It depends on scene helpers for migration/demo creation and is used by both the React UI and WebMCP tools.
 */

import { createDemoSceneSnapshot, createEmptySceneSnapshot, migrateLegacyDocumentToSceneSnapshot } from "./excalidraw.js";
import type { BoardSceneSnapshot } from "./types.js";

const SCENE_STORAGE_KEY = "webmcp-bridge.board.scene";
const LEGACY_DOCUMENT_STORAGE_KEY = "webmcp-bridge.board.document";

type Listener = () => void;
type SnapshotSource = "external" | "canvas";

function parseSceneSnapshot(raw: string): BoardSceneSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const candidate = parsed as { version?: unknown; elements?: unknown; appState?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.elements)) {
      return undefined;
    }
    const appState = candidate.appState && typeof candidate.appState === "object" ? candidate.appState as Record<string, unknown> : {};
    return {
      version: 1,
      elements: candidate.elements,
      appState: {
        ...(typeof appState.viewBackgroundColor === "string" ? { viewBackgroundColor: appState.viewBackgroundColor } : {}),
        ...(typeof appState.scrollX === "number" ? { scrollX: appState.scrollX } : {}),
        ...(typeof appState.scrollY === "number" ? { scrollY: appState.scrollY } : {}),
        ...(typeof appState.zoom === "number" ? { zoom: appState.zoom } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

function snapshotsEqual(left: BoardSceneSnapshot, right: BoardSceneSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class BoardSceneState {
  private snapshot: BoardSceneSnapshot;
  private selectedElementIds = new Set<string>();
  private listeners = new Set<Listener>();
  private pendingCanvasSnapshotJson: string | undefined;

  private constructor(snapshot: BoardSceneSnapshot) {
    this.snapshot = snapshot;
  }

  static async load(): Promise<BoardSceneState> {
    const rawScene = globalThis.localStorage?.getItem(SCENE_STORAGE_KEY);
    const parsedScene = rawScene ? parseSceneSnapshot(rawScene) : undefined;
    if (parsedScene) {
      return new BoardSceneState(parsedScene);
    }

    const rawLegacyDocument = globalThis.localStorage?.getItem(LEGACY_DOCUMENT_STORAGE_KEY);
    if (rawLegacyDocument) {
      const migrated = await migrateLegacyDocumentToSceneSnapshot(rawLegacyDocument);
      const state = new BoardSceneState(migrated);
      state.persist();
      globalThis.localStorage?.removeItem(LEGACY_DOCUMENT_STORAGE_KEY);
      return state;
    }

    const demoSnapshot = await createDemoSceneSnapshot();
    const state = new BoardSceneState(demoSnapshot);
    state.persist();
    return state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.persist();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private persist(): void {
    globalThis.localStorage?.setItem(SCENE_STORAGE_KEY, JSON.stringify(this.snapshot));
  }

  getSnapshot(): BoardSceneSnapshot {
    return this.snapshot;
  }

  setSnapshot(snapshot: BoardSceneSnapshot, source: SnapshotSource = "external"): boolean {
    const serializedSnapshot = JSON.stringify(snapshot);
    if (source === "canvas" && this.pendingCanvasSnapshotJson && serializedSnapshot !== this.pendingCanvasSnapshotJson) {
      return false;
    }
    if (source === "canvas" && this.pendingCanvasSnapshotJson === serializedSnapshot) {
      this.pendingCanvasSnapshotJson = undefined;
    }
    if (source === "external") {
      this.pendingCanvasSnapshotJson = serializedSnapshot;
    }
    if (snapshotsEqual(this.snapshot, snapshot)) {
      return true;
    }
    this.snapshot = snapshot;
    this.emit();
    return true;
  }

  getSelectedElementIds(): Set<string> {
    return new Set(this.selectedElementIds);
  }

  setSelectedElementIds(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (
      this.selectedElementIds.size === next.size &&
      [...this.selectedElementIds].every((id) => next.has(id))
    ) {
      return;
    }
    this.selectedElementIds = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  async resetToDemo(): Promise<void> {
    this.selectedElementIds.clear();
    this.setSnapshot(await createDemoSceneSnapshot());
  }

  clear(): void {
    this.selectedElementIds.clear();
    this.setSnapshot(createEmptySceneSnapshot());
  }
}
