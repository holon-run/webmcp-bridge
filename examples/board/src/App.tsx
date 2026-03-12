/**
 * This module renders the native board example UI and wires the Excalidraw canvas to WebMCP tools.
 * It depends on the example state, Excalidraw interop, and modelContext registration helpers.
 */

import { useEffect, useRef, useState } from "react";
import * as React from "react";
import * as ExcalidrawLib from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { documentToSceneElements, extractSelection, sceneElementsToDocument } from "./excalidraw.js";
import { ensureModelContext } from "./model-context.js";
import { DiagramStore } from "./state.js";
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
  updateScene: (scene: { elements: unknown[]; captureUpdate?: "NEVER" | "EVENTUALLY" | "IMMEDIATELY" }) => void;
  getSceneElements?: () => unknown[];
  getAppState?: () => {
    zoom?: { value?: number };
    scrollX?: number;
    scrollY?: number;
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

function useDiagramStore(): DiagramStore {
  const storeRef = useRef<DiagramStore | undefined>(undefined);
  if (!storeRef.current) {
    storeRef.current = DiagramStore.load();
  }
  return storeRef.current;
}

function estimateSceneElementCount(document: { nodes: readonly unknown[]; edges: readonly { label?: string; protocol?: string }[] }): number {
  const labeledEdges = document.edges.filter((edge) => edge.label || edge.protocol).length;
  return document.nodes.length + document.edges.length + labeledEdges;
}

export function App(): React.ReactElement {
  const store = useDiagramStore();
  const [, setVersion] = useState(0);
  const [sceneVersion, setSceneVersion] = useState(0);
  useEffect(() => {
    return store.subscribe(() => {
      setVersion((value) => value + 1);
    });
  }, [store]);
  const sceneApiRef = useRef<SceneApi | undefined>(undefined);
  const applyingSceneRef = useRef(false);
  const expectedSceneDocumentRef = useRef<string>("");
  const syncRetryCountRef = useRef(0);
  const applyingSceneTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const lastSceneDocumentRef = useRef<string>("");
  const [modelContextReady, setModelContextReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading tools...");
  const [debugTick, setDebugTick] = useState(0);

  const snapshot = store.getSnapshot();
  const summary = store.getSummary();

  useEffect(() => {
    const modelContext = ensureModelContext(globalThis);
    void registerBoardTools(modelContext, store, () => sceneApiRef.current)
      .then(() => {
        setModelContextReady(true);
        setStatusMessage("navigator.modelContext ready");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setModelContextReady(false);
        setStatusMessage(`tool registration failed: ${message}`);
      });
  }, [store]);

  useEffect(() => {
    if (!sceneApiRef.current) {
      return;
    }
    const serializedDocument = JSON.stringify(snapshot.document);
    const currentSceneElements = sceneApiRef.current.getSceneElements?.() ?? [];
    const expectedSceneElementCount = estimateSceneElementCount(snapshot.document);
    const expectsVisibleScene = snapshot.document.nodes.length > 0 || snapshot.document.edges.length > 0;
    const sceneLooksEmpty = currentSceneElements.length === 0;
    const sceneLooksOutOfSync = expectsVisibleScene && currentSceneElements.length !== expectedSceneElementCount;
    if (
      serializedDocument === lastSceneDocumentRef.current &&
      !(expectsVisibleScene && sceneLooksEmpty) &&
      !sceneLooksOutOfSync
    ) {
      return;
    }
    void documentToSceneElements(snapshot.document).then((elements) => {
      applyingSceneRef.current = true;
      expectedSceneDocumentRef.current = serializedDocument;
      syncRetryCountRef.current = 0;
      if (applyingSceneTimeoutRef.current !== undefined) {
        globalThis.clearTimeout(applyingSceneTimeoutRef.current);
      }
      lastSceneDocumentRef.current = serializedDocument;
      if (
        snapshot.document.nodes.length === 0 &&
        snapshot.document.edges.length === 0 ||
        currentSceneElements.length > elements.length
      ) {
        sceneApiRef.current?.resetScene?.();
      }
      sceneApiRef.current?.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction?.NEVER ?? "NEVER",
      });
      globalThis.requestAnimationFrame(() => {
        sceneApiRef.current?.scrollToContent?.(elements, {
          fitToViewport: true,
          viewportZoomFactor: 0.9,
          animate: false,
        });
        sceneApiRef.current?.refresh?.();
      });
      applyingSceneTimeoutRef.current = globalThis.setTimeout(() => {
        const liveSceneCount = sceneApiRef.current?.getSceneElements?.().length ?? 0;
        if (liveSceneCount !== expectedSceneElementCount && syncRetryCountRef.current < 3) {
          syncRetryCountRef.current += 1;
          lastSceneDocumentRef.current = "";
          applyingSceneTimeoutRef.current = undefined;
          setSceneVersion((value) => value + 1);
          return;
        }
        applyingSceneRef.current = false;
        expectedSceneDocumentRef.current = "";
        syncRetryCountRef.current = 0;
        applyingSceneTimeoutRef.current = undefined;
      }, 200);
    });
  }, [snapshot.document, sceneVersion]);

  useEffect(() => {
    return () => {
      if (applyingSceneTimeoutRef.current !== undefined) {
        globalThis.clearTimeout(applyingSceneTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const fitView = (): void => {
      const api = sceneApiRef.current;
      const elements = api?.getSceneElements?.() ?? [];
      api?.scrollToContent?.(elements, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        animate: false,
      });
      api?.refresh?.();
    };

    (globalThis as typeof globalThis & { __boardFitView?: () => void }).__boardFitView = fitView;
    return () => {
      delete (globalThis as typeof globalThis & { __boardFitView?: () => void }).__boardFitView;
    };
  }, []);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      setDebugTick((value) => value + 1);
    }, 500);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const boardGlobal = globalThis as typeof globalThis & { __excalidrawAPI?: SceneApi };
    if (sceneApiRef.current) {
      boardGlobal.__excalidrawAPI = sceneApiRef.current;
    } else {
      delete boardGlobal.__excalidrawAPI;
    }
    return () => {
      delete boardGlobal.__excalidrawAPI;
    };
  });

  const sceneElements = sceneApiRef.current?.getSceneElements?.() ?? [];
  const appState = sceneApiRef.current?.getAppState?.();
  void debugTick;

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>Native WebMCP Example</p>
          <h1 style={styles.title}>Board</h1>
          <p style={styles.subtitle}>Human tweaks the board in the browser while AI edits the same diagram through WebMCP tools.</p>
        </div>
        <div style={styles.actions}>
          <button style={styles.primaryButton} onClick={() => store.resetToDemo()}>
            Load Demo
          </button>
          <button style={styles.secondaryButton} onClick={() => store.clear()}>
            Clear
          </button>
          <button style={styles.secondaryButton} onClick={() => store.removeSelection()}>
            Delete Selection
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              const elements = sceneApiRef.current?.getSceneElements?.() ?? [];
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
                setSceneVersion((value) => value + 1);
              }}
              onChange={(elements: unknown[], appState: unknown) => {
                const selectedElementIds =
                  appState && typeof appState === "object"
                    ? new Set(
                        Object.entries(
                          ((appState as { selectedElementIds?: Record<string, boolean> }).selectedElementIds ?? {}),
                        )
                          .filter(([, selected]) => selected)
                          .map(([elementId]) => elementId),
                      )
                    : new Set<string>();
                const nextDocument = sceneElementsToDocument(store.getDocument(), elements);
                const serializedNextDocument = JSON.stringify(nextDocument);
                if (applyingSceneRef.current) {
                  if (serializedNextDocument === expectedSceneDocumentRef.current) {
                    applyingSceneRef.current = false;
                    expectedSceneDocumentRef.current = "";
                    syncRetryCountRef.current = 0;
                    if (applyingSceneTimeoutRef.current !== undefined) {
                      globalThis.clearTimeout(applyingSceneTimeoutRef.current);
                      applyingSceneTimeoutRef.current = undefined;
                    }
                  }
                } else {
                  lastSceneDocumentRef.current = serializedNextDocument;
                  store.setDocument(nextDocument);
                }
                store.setSelection(extractSelection(elements, selectedElementIds));
              }}
              initialData={{
                appState: {
                  viewBackgroundColor: "#f7fee7",
                },
              }}
              theme="light"
            />
          </div>
        </section>
        <aside style={styles.sidebar}>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Session</p>
            <h2 style={styles.cardTitle}>WebMCP Status</h2>
            <p style={modelContextReady ? styles.goodStatus : styles.badStatus}>{statusMessage}</p>
            <p style={styles.helperText}>Use `webmcp-local-mcp --url http://127.0.0.1:4173` to connect from the CLI.</p>
          </section>
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
                <dd>{snapshot.selection.nodeIds.length + snapshot.selection.edgeIds.length}</dd>
              </div>
            </dl>
          </section>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Selection</p>
            <h2 style={styles.cardTitle}>Current Focus</h2>
            <p style={styles.helperText}>Selected nodes: {snapshot.selection.nodeIds.join(", ") || "none"}</p>
            <p style={styles.helperText}>Selected edges: {snapshot.selection.edgeIds.join(", ") || "none"}</p>
          </section>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Tools</p>
            <h2 style={styles.cardTitle}>MVP Contract</h2>
            <ul style={styles.toolList}>
              <li>`nodes.list`</li>
              <li>`nodes.upsert`</li>
              <li>`nodes.remove`</li>
              <li>`edges.list`</li>
              <li>`edges.upsert`</li>
              <li>`edges.remove`</li>
              <li>`layout.apply`</li>
              <li>`diagram.reset`</li>
              <li>`diagram.export`</li>
            </ul>
          </section>
          <section style={styles.card}>
            <p style={styles.cardEyebrow}>Debug</p>
            <h2 style={styles.cardTitle}>Canvas State</h2>
            <dl style={styles.metaList}>
              <div style={styles.metaRow}>
                <dt>Store Nodes</dt>
                <dd>{summary.nodeCount}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Store Edges</dt>
                <dd>{summary.edgeCount}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Scene Elements</dt>
                <dd>{sceneElements.length}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Zoom</dt>
                <dd>{appState?.zoom?.value?.toFixed(2) ?? "n/a"}</dd>
              </div>
              <div style={styles.metaRow}>
                <dt>Scroll</dt>
                <dd>{appState ? `${Math.round(appState.scrollX ?? 0)}, ${Math.round(appState.scrollY ?? 0)}` : "n/a"}</dd>
              </div>
            </dl>
            <div style={styles.debugActions}>
              <button
                style={styles.secondaryButton}
                onClick={() => {
                  lastSceneDocumentRef.current = "";
                  setSceneVersion((value) => value + 1);
                }}
              >
                Force Sync
              </button>
              <button
                style={styles.secondaryButton}
                onClick={() => {
                  const elements = sceneApiRef.current?.getSceneElements?.() ?? [];
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
          </section>
        </aside>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
    gridTemplateColumns: "minmax(0, 1fr) 320px",
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
    minHeight: 0,
    overflow: "auto",
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
    gap: "12px",
    padding: "8px 0",
    borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
  },
  toolList: {
    margin: 0,
    paddingInlineStart: "18px",
    display: "grid",
    gap: "8px",
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: "13px",
  },
  debugActions: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
    marginTop: "16px",
  },
};
