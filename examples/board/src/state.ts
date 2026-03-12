/**
 * This module manages mutable diagram state, persistence, and subscriptions for the example app.
 * It depends on the pure model helpers and is used by both the React UI and WebMCP tool layer.
 */

import {
  applyLayout,
  createDemoDocument,
  createEmptyDocument,
  createSnapshot,
  removeEdgesById,
  removeBySelection,
  removeDanglingEdges,
  removeNodesById,
  summarizeDocument,
  upsertEdges,
  upsertNodes,
} from "./model.js";
import type {
  DiagramDocument,
  DiagramExportFormat,
  DiagramSelection,
  DiagramSnapshot,
  LayoutMode,
  LayoutScope,
  UpsertEdgeInput,
  UpsertNodeInput,
} from "./types.js";

const STORAGE_KEY = "webmcp-bridge.board.document";

type Listener = () => void;

function selectionsEqual(left: DiagramSelection, right: DiagramSelection): boolean {
  if (left.nodeIds.length !== right.nodeIds.length || left.edgeIds.length !== right.edgeIds.length) {
    return false;
  }
  return (
    left.nodeIds.every((value, index) => value === right.nodeIds[index]) &&
    left.edgeIds.every((value, index) => value === right.edgeIds[index])
  );
}

function documentsEqual(left: DiagramDocument, right: DiagramDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isDiagramDocument(value: unknown): value is DiagramDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { version?: unknown; nodes?: unknown; edges?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}

export class DiagramStore {
  private document: DiagramDocument;
  private selection: DiagramSelection;
  private listeners = new Set<Listener>();

  constructor(initialDocument?: DiagramDocument) {
    this.document = initialDocument ?? createEmptyDocument();
    this.selection = { nodeIds: [], edgeIds: [] };
  }

  static load(): DiagramStore {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return new DiagramStore(createDemoDocument());
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isDiagramDocument(parsed)) {
        return new DiagramStore(removeDanglingEdges(parsed));
      }
    } catch {
      // Ignore parse failures and fall back to the demo document.
    }
    return new DiagramStore(createDemoDocument());
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
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.document));
  }

  getSnapshot(): DiagramSnapshot {
    return createSnapshot(this.document, this.selection);
  }

  getDocument(): DiagramDocument {
    return this.document;
  }

  getSelection(): DiagramSelection {
    return this.selection;
  }

  getSummary() {
    return summarizeDocument(this.document);
  }

  setDocument(document: DiagramDocument): void {
    const nextDocument = removeDanglingEdges(document);
    if (documentsEqual(this.document, nextDocument)) {
      return;
    }
    this.document = nextDocument;
    this.emit();
  }

  setSelection(selection: DiagramSelection): void {
    if (selectionsEqual(this.selection, selection)) {
      return;
    }
    this.selection = selection;
    this.emit();
  }

  resetToDemo(): void {
    this.document = createDemoDocument();
    this.selection = { nodeIds: [], edgeIds: [] };
    this.emit();
  }

  clear(): void {
    this.document = createEmptyDocument();
    this.selection = { nodeIds: [], edgeIds: [] };
    this.emit();
  }

  upsertNodes(inputs: UpsertNodeInput[]): DiagramDocument {
    this.document = upsertNodes(this.document, inputs);
    this.emit();
    return this.document;
  }

  upsertEdges(inputs: UpsertEdgeInput[]): DiagramDocument {
    this.document = upsertEdges(this.document, inputs);
    this.emit();
    return this.document;
  }

  removeNodes(nodeIds: string[]): DiagramDocument {
    this.document = removeNodesById(this.document, nodeIds);
    this.selection = {
      nodeIds: this.selection.nodeIds.filter((nodeId) => !nodeIds.includes(nodeId)),
      edgeIds: this.selection.edgeIds.filter((edgeId) => this.document.edges.some((edge) => edge.id === edgeId)),
    };
    this.emit();
    return this.document;
  }

  removeEdges(edgeIds: string[]): DiagramDocument {
    this.document = removeEdgesById(this.document, edgeIds);
    this.selection = {
      nodeIds: this.selection.nodeIds,
      edgeIds: this.selection.edgeIds.filter((edgeId) => !edgeIds.includes(edgeId)),
    };
    this.emit();
    return this.document;
  }

  applyLayout(mode: LayoutMode, scope: LayoutScope): DiagramDocument {
    this.document = applyLayout(this.document, mode, scope, this.selection);
    this.emit();
    return this.document;
  }

  removeSelection(): DiagramDocument {
    this.document = removeBySelection(this.document, this.selection);
    this.selection = { nodeIds: [], edgeIds: [] };
    this.emit();
    return this.document;
  }

  async exportDiagram(
    format: DiagramExportFormat,
    api?: { getSceneElements?: () => unknown[]; exportToBlob?: (opts: unknown) => Promise<Blob> },
  ) {
    if (format === "json") {
      return this.document;
    }
    if (!api?.exportToBlob) {
      throw new Error("png export requires an active Excalidraw API");
    }
    const blob = await api.exportToBlob({
      mimeType: "image/png",
      elements: api.getSceneElements?.() ?? [],
      appState: {
        exportBackground: true,
      },
      files: {},
    });
    return await blobToDataUrl(blob);
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("failed to read export blob"));
    };
    reader.readAsDataURL(blob);
  });
}
