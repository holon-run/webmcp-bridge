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
      "nodes.list",
      "nodes.upsert",
      "nodes.remove",
      "edges.list",
      "edges.upsert",
      "edges.remove",
      "layout.apply",
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
});
