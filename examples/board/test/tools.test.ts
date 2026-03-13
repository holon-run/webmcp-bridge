/**
 * This module verifies the native board WebMCP tool registration contract against the scene-first board state.
 * It depends on the in-memory modelContext and persisted scene snapshots so tool names and result shapes remain stable.
 */

import { vi } from "vitest";
import { ensureModelContext } from "../src/model-context.js";
import { BoardSceneState } from "../src/scene-state.js";
import { registerBoardTools } from "../src/tools.js";

const SEEDED_SCENE = {
  version: 1,
  title: "Board WebMCP Demo",
  elements: [
    {
      id: "node-shape-client",
      type: "rectangle",
      x: 80,
      y: 140,
      width: 260,
      height: 120,
      customData: { bridgeType: "node", bridgeId: "client", nodeKind: "actor" },
    },
    { id: "node-text-client", type: "text", text: "Client App", containerId: "node-shape-client", x: 120, y: 180 },
    {
      id: "node-shape-gateway",
      type: "rectangle",
      x: 420,
      y: 140,
      width: 260,
      height: 120,
      customData: { bridgeType: "node", bridgeId: "gateway", nodeKind: "service" },
    },
    { id: "node-text-gateway", type: "text", text: "API Gateway", containerId: "node-shape-gateway", x: 460, y: 180 },
    {
      id: "node-shape-orders",
      type: "rectangle",
      x: 760,
      y: 40,
      width: 260,
      height: 120,
      customData: { bridgeType: "node", bridgeId: "orders", nodeKind: "service" },
    },
    { id: "node-text-orders", type: "text", text: "Orders Service", containerId: "node-shape-orders", x: 800, y: 80 },
    {
      id: "edge-line-orders",
      type: "arrow",
      x: 680,
      y: 200,
      points: [[0, 0], [80, -80]],
      customData: {
        bridgeType: "edge",
        bridgeId: "e-orders",
        sourceNodeId: "gateway",
        targetNodeId: "orders",
        protocol: "grpc",
      },
    },
    {
      id: "edge-text-orders",
      type: "text",
      text: "grpc",
      containerId: "edge-line-orders",
      x: 720,
      y: 140,
      strokeColor: "#334155",
    },
  ],
  appState: {
    viewBackgroundColor: "#f7fee7",
  },
};

type MemoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function createMemoryStorage(seed: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("board tools", () => {
  beforeEach(() => {
    vi.unmock("@excalidraw/excalidraw");
    delete (globalThis as { __webmcpBoardModelContext?: unknown }).__webmcpBoardModelContext;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage({
        "webmcp-bridge.board.scene": JSON.stringify(SEEDED_SCENE),
      }),
    });
  });

  it("registers the MVP toolset", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);

    const tools = await modelContext.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "diagram.get",
      "diagram.loadDemo",
      "diagram.setTitle",
      "nodes.list",
      "nodes.upsert",
      "nodes.style",
      "nodes.resize",
      "nodes.remove",
      "edges.list",
      "edges.upsert",
      "edges.style",
      "edges.remove",
      "selection.get",
      "selection.remove",
      "layout.apply",
      "canvas.style",
      "view.fit",
      "diagram.reset",
      "diagram.export",
    ]);
  });

  it("returns structured node data from nodes.list", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    const result = await modelContext.callTool("nodes.list", {});

    expect(result).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: "orders", label: "Orders Service", kind: "service" }),
      ]),
      summary: {
        nodeCount: 3,
        edgeCount: 1,
      },
    });
  });

  it("returns the full structured document from diagram.get", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    const result = await modelContext.callTool("diagram.get", {});

    expect(result).toMatchObject({
      title: "Board WebMCP Demo",
      document: {
        version: 1,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "gateway", label: "API Gateway" }),
        ]),
        edges: expect.arrayContaining([
          expect.objectContaining({ id: "e-orders", sourceNodeId: "gateway", targetNodeId: "orders" }),
        ]),
      },
      summary: {
        nodeCount: 3,
        edgeCount: 1,
      },
    });
  });

  it("updates the diagram title through diagram.setTitle", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    const result = await modelContext.callTool("diagram.setTitle", {
      title: "Board WebMCP Showcase",
    });

    expect(result).toMatchObject({
      title: "Board WebMCP Showcase",
      summary: {
        nodeCount: 3,
        edgeCount: 1,
      },
    });

    const snapshot = sceneState.getSnapshot();
    expect(snapshot.title).toBe("Board WebMCP Showcase");
  });

  it("removes nodes and dangling edges", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    await modelContext.callTool("nodes.remove", { nodeIds: ["orders"] });
    const nodes = await modelContext.callTool("nodes.list", {});
    const edges = await modelContext.callTool("edges.list", {});

    expect(nodes).toMatchObject({
      items: expect.not.arrayContaining([expect.objectContaining({ id: "orders" })]),
    });
    expect(edges).toMatchObject({
      items: [],
    });
  });

  it("patches node style and size through scene-first tools", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    await modelContext.callTool("nodes.style", {
      nodeIds: ["orders"],
      strokeColor: "#2563eb",
      backgroundColor: "#dbeafe",
      textColor: "#1e3a8a",
      fillStyle: "solid",
      roughness: 0,
      opacity: 80,
    });
    await modelContext.callTool("nodes.resize", {
      nodeIds: ["orders"],
      width: 320,
      height: 140,
    });
    const nodes = await modelContext.callTool("nodes.list", {});

    expect(nodes).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "orders",
          width: 320,
          height: 140,
          style: expect.objectContaining({
            strokeColor: "#2563eb",
            backgroundColor: "#dbeafe",
            textColor: "#1e3a8a",
            fillStyle: "solid",
            roughness: 0,
            opacity: 80,
          }),
        }),
      ]),
    });
  });

  it("patches edge style and canvas style", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    await modelContext.callTool("edges.style", {
      edgeIds: ["e-orders"],
      strokeColor: "#ea580c",
      textColor: "#9a3412",
      strokeStyle: "dashed",
      strokeWidth: 3,
      opacity: 70,
    });
    await modelContext.callTool("canvas.style", {
      backgroundColor: "#fafaf9",
    });
    const edges = await modelContext.callTool("edges.list", {});

    expect(edges).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "e-orders",
          style: expect.objectContaining({
            strokeColor: "#ea580c",
            textColor: "#9a3412",
            strokeStyle: "dashed",
            strokeWidth: 3,
            opacity: 70,
          }),
        }),
      ]),
    });
    expect(sceneState.getSnapshot().appState.viewBackgroundColor).toBe("#fafaf9");
  });

  it("returns and removes the current structured selection", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();
    sceneState.setSelectedElementIds(["node-shape-orders", "edge-line-orders"]);

    await registerBoardTools(modelContext, sceneState, () => undefined);

    const selection = await modelContext.callTool("selection.get", {});
    expect(selection).toMatchObject({
      selection: {
        nodeIds: ["orders"],
        edgeIds: ["e-orders"],
      },
      summary: {
        nodeCount: 3,
        edgeCount: 1,
      },
    });

    const removed = await modelContext.callTool("selection.remove", {});
    expect(removed).toMatchObject({
      document: {
        nodes: expect.not.arrayContaining([expect.objectContaining({ id: "orders" })]),
        edges: [],
      },
      summary: {
        nodeCount: 2,
        edgeCount: 0,
      },
    });
    expect(sceneState.getSelectedElementIds().size).toBe(0);
  });

  it("loads the built-in demo scene through diagram.loadDemo", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => undefined);
    const result = await modelContext.callTool("diagram.loadDemo", {});

    expect(result).toMatchObject({
      document: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "agent", kind: "actor" }),
          expect.objectContaining({ id: "website", kind: "external" }),
        ]),
        edges: expect.arrayContaining([
          expect.objectContaining({ id: "e-playwright-native", sourceNodeId: "playwright", targetNodeId: "model-context" }),
        ]),
      },
      summary: {
        nodeCount: 7,
        edgeCount: 7,
      },
    });
  });

  it("fits the current view through the live Excalidraw api", async () => {
    const scrollToContent = vi.fn();
    const refresh = vi.fn();
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();

    await registerBoardTools(modelContext, sceneState, () => ({
      getSceneElements: () => sceneState.getSnapshot().elements,
      scrollToContent,
      refresh,
    }));
    const result = await modelContext.callTool("view.fit", {
      animate: true,
      viewportZoomFactor: 0.8,
    });

    expect(scrollToContent).toHaveBeenCalledTimes(1);
    expect(scrollToContent).toHaveBeenCalledWith(sceneState.getSnapshot().elements, {
      fitToViewport: true,
      viewportZoomFactor: 0.8,
      animate: true,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      summary: expect.objectContaining({ nodeCount: 3, edgeCount: 1 }),
    });
  });
});
