/**
 * This module verifies scene snapshot persistence and migration for the native board example.
 * It depends on the scene state and legacy model helpers so storage upgrades stay safe.
 */

import { vi } from "vitest";
import { createDemoDocument } from "../src/model.js";
import { BoardSceneState } from "../src/scene-state.js";

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

describe("board scene state", () => {
  beforeEach(() => {
    vi.unmock("@excalidraw/excalidraw");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  it("migrates the legacy document storage into a scene snapshot", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const storage = createMemoryStorage({
      "webmcp-bridge.board.document": JSON.stringify(createDemoDocument()),
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });

    const state = await BoardSceneState.load();

    expect(state.getSnapshot().elements.length).toBeGreaterThan(0);
    expect(storage.getItem("webmcp-bridge.board.scene")).toContain("elements");
    expect(storage.getItem("webmcp-bridge.board.document")).toBeNull();
  });

  it("normalizes persisted scene arrows into bound arrows", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const storage = createMemoryStorage({
      "webmcp-bridge.board.scene": JSON.stringify({
        version: 1,
        elements: [
          {
            id: "node-shape-source",
            type: "rectangle",
            x: 80,
            y: 120,
            width: 260,
            height: 120,
            customData: { bridgeType: "node", bridgeId: "source", nodeKind: "service" },
          },
          {
            id: "node-shape-target",
            type: "rectangle",
            x: 480,
            y: 120,
            width: 260,
            height: 120,
            customData: { bridgeType: "node", bridgeId: "target", nodeKind: "service" },
          },
          {
            id: "edge-line-edge-1",
            type: "arrow",
            x: 210,
            y: 180,
            points: [[0, 0], [400, 0]],
            customData: {
              bridgeType: "edge",
              bridgeId: "edge-1",
              sourceNodeId: "source",
              targetNodeId: "target",
            },
          },
        ],
        appState: {
          viewBackgroundColor: "#f7fee7",
        },
      }),
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });

    const state = await BoardSceneState.load();
    const arrow = state.getSnapshot().elements.find((element) => {
      return Boolean(element) && typeof element === "object" && (element as { type?: string }).type === "arrow";
    }) as
      | {
          startBinding?: { elementId?: string } | null;
          endBinding?: { elementId?: string } | null;
        }
      | undefined;

    expect(arrow?.startBinding?.elementId).toBe("node-shape-source");
    expect(arrow?.endBinding?.elementId).toBe("node-shape-target");
    expect(JSON.parse(storage.getItem("webmcp-bridge.board.scene") ?? "{}")).toMatchObject({
      elements: expect.arrayContaining([
        expect.objectContaining({
          id: "edge-line-edge-1",
          startBinding: expect.objectContaining({ elementId: "node-shape-source" }),
          endBinding: expect.objectContaining({ elementId: "node-shape-target" }),
        }),
      ]),
    });
  });
});
