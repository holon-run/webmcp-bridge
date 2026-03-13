/**
 * This module renders the native board example UI and wires the Excalidraw canvas directly to the scene-first WebMCP tools.
 * It depends on the scene state, Excalidraw interop helpers, and modelContext registration helpers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as React from "react";
import * as ExcalidrawLib from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  createRawSceneSnapshot,
  createSceneSnapshot,
  deriveDocumentFromScene,
  deriveSelection,
  deriveSummaryFromScene,
  removeSelectionFromScene,
  selectedElementIdsFromAppState,
  toExcalidrawAppState,
} from "./excalidraw.js";
import { ensureModelContext } from "./model-context.js";
import { BoardSceneState } from "./scene-state.js";
import { registerBoardTools } from "./tools.js";

const Excalidraw = (ExcalidrawLib as unknown as { Excalidraw: React.ComponentType<Record<string, unknown>> }).Excalidraw;
const CaptureUpdateAction = (
  ExcalidrawLib as unknown as {
    CaptureUpdateAction?: {
      NEVER?: "NEVER";
    };
  }
).CaptureUpdateAction;

type SceneApi = {
  updateScene: (scene: {
    elements: unknown[];
    appState?: Record<string, unknown>;
    captureUpdate?: "NEVER" | "EVENTUALLY" | "IMMEDIATELY";
  }) => void;
  getSceneElements?: () => unknown[];
  getAppState?: () => {
    zoom?: { value?: number };
    scrollX?: number;
    scrollY?: number;
    selectedElementIds?: Record<string, boolean>;
  };
  exportToBlob?: (opts: unknown) => Promise<Blob>;
  resetScene?: () => void;
  scrollToContent?: (
    target?: unknown[] | string | unknown,
    opts?: {
      fitToContent?: boolean;
      fitToViewport?: boolean;
      viewportZoomFactor?: number;
      animate?: boolean;
      duration?: number;
    },
  ) => void;
  refresh?: () => void;
};

export function App(): React.ReactElement {
  const [sceneState, setSceneState] = useState<BoardSceneState | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [renderTick, setRenderTick] = useState(0);
  const [modelContextReady, setModelContextReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading board state...");
  const [debugTick, setDebugTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sceneApiRef = useRef<SceneApi | undefined>(undefined);
  const lastAppliedSnapshotRef = useRef("");

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    void BoardSceneState.load().then((loadedState) => {
      if (!mounted) {
        return;
      }
      setSceneState(loadedState);
      setStatusMessage("Loading tools...");
      unsubscribe = loadedState.subscribe(() => {
        setVersion((value) => value + 1);
      });
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!sceneState) {
      return;
    }
    const modelContext = ensureModelContext(globalThis);
    void registerBoardTools(modelContext, sceneState, () => sceneApiRef.current)
      .then(() => {
        setModelContextReady(true);
        setStatusMessage("navigator.modelContext ready");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setModelContextReady(false);
        setStatusMessage(`tool registration failed: ${message}`);
      });
  }, [sceneState]);

  useEffect(() => {
    if (!sceneState || !sceneApiRef.current) {
      return;
    }
    const snapshot = sceneState.getSnapshot();
    const serializedSnapshot = JSON.stringify(snapshot);
    if (serializedSnapshot === lastAppliedSnapshotRef.current) {
      return;
    }
    const currentElements = sceneApiRef.current.getSceneElements?.() ?? [];
    if (snapshot.elements.length === 0 || currentElements.length > snapshot.elements.length) {
      sceneApiRef.current.resetScene?.();
    }
    sceneApiRef.current.updateScene({
      elements: snapshot.elements,
      appState: toExcalidrawAppState(snapshot.appState),
      captureUpdate: CaptureUpdateAction?.NEVER ?? "NEVER",
    });
    sceneApiRef.current.refresh?.();
    lastAppliedSnapshotRef.current = serializedSnapshot;
  }, [sceneState, version, renderTick]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      setDebugTick((value) => value + 1);
    }, 500);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const boardGlobal = globalThis as typeof globalThis & { __excalidrawAPI?: SceneApi; __boardFitView?: () => void };
    if (sceneApiRef.current) {
      boardGlobal.__excalidrawAPI = sceneApiRef.current;
      boardGlobal.__boardFitView = () => {
        const elements = sceneApiRef.current?.getSceneElements?.() ?? [];
        sceneApiRef.current?.scrollToContent?.(elements, {
          fitToViewport: true,
          viewportZoomFactor: 0.9,
          animate: false,
        });
        sceneApiRef.current?.refresh?.();
      };
    } else {
      delete boardGlobal.__excalidrawAPI;
      delete boardGlobal.__boardFitView;
    }
    return () => {
      delete boardGlobal.__excalidrawAPI;
      delete boardGlobal.__boardFitView;
    };
  });

  const snapshot = sceneState?.getSnapshot();
  const selectedElementIds = sceneState?.getSelectedElementIds() ?? new Set<string>();
  const selection = useMemo(() => (snapshot ? deriveSelection(snapshot, selectedElementIds) : { nodeIds: [], edgeIds: [] }), [snapshot, selectedElementIds]);
  const summary = useMemo(
    () => (snapshot ? deriveSummaryFromScene(snapshot) : { nodeCount: 0, edgeCount: 0, kinds: { actor: 0, service: 0, database: 0, queue: 0, cache: 0, external: 0 } }),
    [snapshot],
  );
  const derivedDocument = useMemo(() => (snapshot ? deriveDocumentFromScene(snapshot) : { version: 1 as const, nodes: [], edges: [] }), [snapshot]);
  const sceneElements = sceneApiRef.current?.getSceneElements?.() ?? snapshot?.elements ?? [];
  const appState = sceneApiRef.current?.getAppState?.();
  void debugTick;

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    globalThis.document.title = snapshot.title;
  }, [snapshot]);

  if (!sceneState || !snapshot) {
    return (
      <div style={styles.loadingShell}>
        <div style={styles.loadingCard}>
          <p style={styles.eyebrow}>Excalidraw + WebMCP Demo</p>
          <h1 style={styles.title}>Board</h1>
          <p style={styles.subtitle}>Loading scene snapshot…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>Excalidraw + WebMCP Demo</p>
          <h1 style={styles.title}>{snapshot.title}</h1>
          <p style={styles.subtitle}>Built on Excalidraw. Human tweaks the board in the browser while AI edits the same diagram through WebMCP tools.</p>
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>WebMCP</span>
            <span style={modelContextReady ? styles.goodStatusBadge : styles.badStatusBadge}>{statusMessage}</span>
            <span style={styles.statusHint}>`webmcp-local-mcp --url http://127.0.0.1:4173`</span>
          </div>
        </div>
        <div style={styles.actions}>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              setSidebarOpen((value) => !value);
            }}
          >
            {sidebarOpen ? "Hide Panel" : "Show Panel"}
          </button>
          <button
            style={styles.primaryButton}
            onClick={() => {
              void sceneState.resetToDemo().then(() => {
                lastAppliedSnapshotRef.current = "";
                setRenderTick((value) => value + 1);
              });
            }}
          >
            Load Demo
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              sceneState.clear();
              lastAppliedSnapshotRef.current = "";
              setRenderTick((value) => value + 1);
            }}
          >
            Clear
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              void removeSelectionFromScene(sceneState.getSnapshot(), sceneState.getSelectedElementIds()).then((nextSnapshot) => {
                sceneState.setSelectedElementIds([]);
                sceneState.setSnapshot(nextSnapshot);
              });
            }}
          >
            Delete Selection
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              const elements = sceneApiRef.current?.getSceneElements?.() ?? snapshot.elements;
              sceneApiRef.current?.scrollToContent?.(elements, {
                fitToViewport: true,
                viewportZoomFactor: 0.9,
                animate: false,
              });
              sceneApiRef.current?.refresh?.();
            }}
          >
            Fit View
          </button>
        </div>
      </header>
      <main style={styles.main}>
        <section style={styles.canvasPanel}>
          <div style={styles.canvasFrame}>
            <Excalidraw
              excalidrawAPI={(api: unknown) => {
                sceneApiRef.current = api as SceneApi;
                lastAppliedSnapshotRef.current = JSON.stringify(sceneState.getSnapshot());
              }}
              onChange={(elements: unknown[], nextAppState: unknown) => {
                const nextSelectionIds = selectedElementIdsFromAppState(nextAppState);
                sceneState.setSelectedElementIds(nextSelectionIds);
                const rawSnapshot = createRawSceneSnapshot(elements, nextAppState);
                const nextSnapshot = createSceneSnapshot(elements, nextAppState);
                const rawSerializedSnapshot = JSON.stringify(rawSnapshot);
                const normalizedSerializedSnapshot = JSON.stringify(nextSnapshot);
                sceneState.setSnapshot(nextSnapshot, "canvas");
                if (rawSerializedSnapshot !== normalizedSerializedSnapshot) {
                  sceneApiRef.current?.updateScene({
                    elements: nextSnapshot.elements,
                    appState: toExcalidrawAppState(nextSnapshot.appState),
                    captureUpdate: CaptureUpdateAction?.NEVER ?? "NEVER",
                  });
                  sceneApiRef.current?.refresh?.();
                }
                lastAppliedSnapshotRef.current = normalizedSerializedSnapshot;
              }}
              initialData={{
                elements: snapshot.elements,
                appState: toExcalidrawAppState(snapshot.appState),
              }}
              theme="light"
            />
          </div>
        </section>
        <aside style={sidebarOpen ? styles.sidebar : styles.sidebarHidden}>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Diagram</p>
            <h2 style={styles.cardTitle}>Summary</h2>
            <dl style={styles.metaList}>
              <div style={styles.metaRow}>
                <dt>Nodes</dt>
                <dd>{summary.nodeCount}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Edges</dt>
                <dd>{summary.edgeCount}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Selection</dt>
                <dd>{selection.nodeIds.length + selection.edgeIds.length}</dd>
              </div>
            </dl>
          </section>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Selection</p>
            <h2 style={styles.cardTitle}>Current Focus</h2>
            <p style={styles.helperText}>Selected nodes: {selection.nodeIds.join(", ") || "none"}</p>
            <p style={styles.helperText}>Selected edges: {selection.edgeIds.join(", ") || "none"}</p>
          </section>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Tools</p>
            <h2 style={styles.cardTitle}>WebMCP Tools</h2>
            <ul style={styles.toolList}>
              <li>`nodes.list`</li>
              <li>`nodes.upsert`</li>
              <li>`nodes.style`</li>
              <li>`nodes.resize`</li>
              <li>`nodes.remove`</li>
              <li>`edges.list`</li>
              <li>`edges.upsert`</li>
              <li>`edges.style`</li>
              <li>`edges.remove`</li>
              <li>`selection.get`</li>
              <li>`selection.remove`</li>
              <li>`layout.apply`</li>
              <li>`canvas.style`</li>
              <li>`view.fit`</li>
              <li>`diagram.get`</li>
              <li>`diagram.loadDemo`</li>
              <li>`diagram.reset`</li>
              <li>`diagram.export`</li>
            </ul>
          </section>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Debug</p>
            <h2 style={styles.cardTitle}>Canvas State</h2>
            <dl style={styles.metaList}>
              <div style={styles.metaRow}>
                <dt>Derived Nodes</dt>
                <dd>{summary.nodeCount}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Derived Edges</dt>
                <dd>{summary.edgeCount}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Scene Elements</dt>
                <dd>{sceneElements.length}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Zoom</dt>
                <dd>{appState?.zoom?.value?.toFixed(2) ?? snapshot.appState.zoom?.toFixed(2) ?? "n/a"}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Scroll</dt>
                <dd>
                  {appState
                    ? `${Math.round(appState.scrollX ?? 0)}, ${Math.round(appState.scrollY ?? 0)}`
                    : `${Math.round(snapshot.appState.scrollX ?? 0)}, ${Math.round(snapshot.appState.scrollY ?? 0)}`}
                </dd>
              </div>
            </dl>
            <div style={styles.debugActions}>
              <button
                style={styles.secondaryButton}
                onClick={() => {
                  lastAppliedSnapshotRef.current = "";
                  setRenderTick((value) => value + 1);
                }}
              >
                Force Sync
              </button>
              <button
                style={styles.secondaryButton}
                onClick={() => {
                  const elements = sceneApiRef.current?.getSceneElements?.() ?? snapshot.elements;
                  sceneApiRef.current?.scrollToContent?.(elements, {
                    fitToViewport: true,
                    viewportZoomFactor: 0.9,
                    animate: false,
                  });
                  sceneApiRef.current?.refresh?.();
                }}
              >
                Force Fit
              </button>
            </div>
            <p style={styles.helperText}>Derived scene nodes: {derivedDocument.nodes.map((node) => node.id).join(", ") || "none"}</p>
          </section>
        </aside>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loadingShell: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    background:
      "radial-gradient(circle at top left, rgba(16, 185, 129, 0.14), transparent 32%), linear-gradient(135deg, #f7fee7 0%, #eff6ff 52%, #fff7ed 100%)",
    padding: "24px",
  },
  loadingCard: {
    borderRadius: "24px",
    background: "rgba(255,255,255,0.9)",
    padding: "24px 28px",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
  },
  shell: {
    minHeight: "100dvh",
    height: "100dvh",
    background:
      "radial-gradient(circle at top left, rgba(16, 185, 129, 0.14), transparent 32%), linear-gradient(135deg, #f7fee7 0%, #eff6ff 52%, #fff7ed 100%)",
    color: "#0f172a",
    fontFamily: '"IBM Plex Sans", "Helvetica Neue", sans-serif',
    padding: "24px",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: "24px",
    alignItems: "flex-start",
    marginBottom: "24px",
    flexWrap: "wrap",
  },
  eyebrow: {
    margin: 0,
    fontSize: "12px",
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "#0f766e",
    fontWeight: 700,
  },
  title: {
    margin: "8px 0 12px",
    fontSize: "40px",
    lineHeight: 1.05,
  },
  subtitle: {
    margin: 0,
    maxWidth: "720px",
    color: "#334155",
  },
  statusRow: {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: "14px",
  },
  statusLabel: {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: "#64748b",
    fontWeight: 700,
  },
  actions: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
  primaryButton: {
    background: "#0f766e",
    color: "#ffffff",
    border: "none",
    borderRadius: "999px",
    padding: "12px 18px",
    cursor: "pointer",
    fontWeight: 700,
  },
  secondaryButton: {
    background: "rgba(255,255,255,0.78)",
    color: "#0f172a",
    border: "1px solid rgba(15, 23, 42, 0.12)",
    borderRadius: "999px",
    padding: "12px 18px",
    cursor: "pointer",
    fontWeight: 700,
  },
  main: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "24px",
    flex: 1,
    minHeight: 0,
  },
  canvasPanel: {
    minWidth: 0,
    minHeight: 0,
  },
  canvasFrame: {
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    borderRadius: "28px",
    border: "1px solid rgba(15, 23, 42, 0.08)",
    boxShadow: "0 24px 80px rgba(15, 23, 42, 0.12)",
    background: "rgba(255, 255, 255, 0.88)",
  },
  sidebar: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    width: "320px",
    minHeight: 0,
    overflow: "auto",
  },
  sidebarHidden: {
    display: "none",
  },
  card: {
    borderRadius: "24px",
    background: "rgba(255, 255, 255, 0.86)",
    border: "1px solid rgba(15, 23, 42, 0.08)",
    padding: "18px",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
  },
  cardEyebrow: {
    margin: 0,
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: "#64748b",
    fontWeight: 700,
  },
  cardTitle: {
    margin: "8px 0 12px",
    fontSize: "20px",
  },
  goodStatus: {
    margin: 0,
    color: "#047857",
    fontWeight: 700,
  },
  badStatus: {
    margin: 0,
    color: "#b91c1c",
    fontWeight: 700,
  },
  goodStatusBadge: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "999px",
    background: "rgba(4, 120, 87, 0.12)",
    color: "#047857",
    padding: "6px 10px",
    fontWeight: 700,
    fontSize: "13px",
  },
  badStatusBadge: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "999px",
    background: "rgba(185, 28, 28, 0.12)",
    color: "#b91c1c",
    padding: "6px 10px",
    fontWeight: 700,
    fontSize: "13px",
  },
  statusHint: {
    color: "#475569",
    fontSize: "13px",
  },
  helperText: {
    margin: "8px 0 0",
    color: "#475569",
    fontSize: "14px",
    lineHeight: 1.5,
  },
  metaList: {
    margin: 0,
  },
  metaRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "6px 0",
    borderBottom: "1px solid rgba(148, 163, 184, 0.18)",
    gap: "12px",
  },
  toolList: {
    margin: 0,
    paddingLeft: "18px",
    color: "#334155",
    lineHeight: 1.7,
  },
  debugActions: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    marginTop: "12px",
  },
};
