/**
 * This module verifies programmatic Excalidraw arrows are bound to node shapes instead of only matching geometry.
 * It depends on the scene conversion helpers so bridge-managed edges keep native editor attachment behavior.
 */

import { documentToSceneElements, normalizeSceneSnapshot } from "../src/excalidraw.js";

describe("excalidraw bindings", () => {
  it("creates arrow bindings for bridge-managed edges", async () => {
    const elements = await documentToSceneElements({
      version: 1,
      nodes: [
        {
          id: "source",
          label: "Source",
          kind: "service",
          x: 80,
          y: 120,
          width: 260,
          height: 120,
        },
        {
          id: "target",
          label: "Target",
          kind: "service",
          x: 480,
          y: 120,
          width: 260,
          height: 120,
        },
      ],
      edges: [
        {
          id: "edge-1",
          sourceNodeId: "source",
          targetNodeId: "target",
          protocol: "native",
        },
      ],
    });

    const arrow = elements.find((element) => {
      return Boolean(element) && typeof element === "object" && (element as { type?: string }).type === "arrow";
    }) as
      | {
          startBinding?: { elementId?: string } | null;
          endBinding?: { elementId?: string } | null;
        }
      | undefined;

    expect(arrow).toBeDefined();
    expect(arrow?.startBinding?.elementId).toBe("node-shape-source");
    expect(arrow?.endBinding?.elementId).toBe("node-shape-target");
  });

  it("attaches arrow bindings using runtime element ids instead of bridge ids", () => {
    const normalized = normalizeSceneSnapshot({
      version: 1,
      title: "Board WebMCP Demo",
      elements: [
        {
          id: "runtime-source",
          type: "rectangle",
          x: 80,
          y: 120,
          width: 260,
          height: 120,
          customData: {
            bridgeType: "node",
            bridgeId: "source",
            nodeKind: "service",
          },
        },
        {
          id: "runtime-target",
          type: "rectangle",
          x: 480,
          y: 120,
          width: 260,
          height: 120,
          customData: {
            bridgeType: "node",
            bridgeId: "target",
            nodeKind: "service",
          },
        },
        {
          id: "runtime-edge",
          type: "arrow",
          x: 340,
          y: 180,
          points: [
            [0, 0],
            [140, 0],
          ],
          customData: {
            bridgeType: "edge",
            bridgeId: "edge-1",
            sourceNodeId: "source",
            targetNodeId: "target",
          },
        },
      ],
      appState: {},
    });

    const arrow = normalized.elements.find((element) => {
      return Boolean(element) && typeof element === "object" && (element as { id?: string }).id === "runtime-edge";
    }) as
      | {
          startBinding?: { elementId?: string } | null;
          endBinding?: { elementId?: string } | null;
        }
      | undefined;

    expect(arrow?.startBinding?.elementId).toBe("runtime-source");
    expect(arrow?.endBinding?.elementId).toBe("runtime-target");
  });

  it("reprojects bridge-managed arrows to node boundaries during scene normalization", () => {
    const normalized = normalizeSceneSnapshot({
      version: 1,
      title: "Board WebMCP Demo",
      elements: [
        {
          id: "runtime-source",
          type: "rectangle",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          customData: {
            bridgeType: "node",
            bridgeId: "source",
            nodeKind: "service",
          },
        },
        {
          id: "runtime-target",
          type: "rectangle",
          x: 500,
          y: 300,
          width: 200,
          height: 100,
          customData: {
            bridgeType: "node",
            bridgeId: "target",
            nodeKind: "service",
          },
        },
        {
          id: "runtime-edge",
          type: "arrow",
          x: 200,
          y: 150,
          points: [
            [0, 0],
            [400, 200],
          ],
          customData: {
            bridgeType: "edge",
            bridgeId: "edge-1",
            sourceNodeId: "source",
            targetNodeId: "target",
          },
        },
      ],
      appState: {},
    });

    const arrow = normalized.elements.find((element) => {
      return Boolean(element) && typeof element === "object" && (element as { id?: string }).id === "runtime-edge";
    }) as
      | {
          x?: number;
          y?: number;
          points?: unknown;
        }
      | undefined;

    expect(arrow?.x).toBeCloseTo(300, 6);
    expect(arrow?.y).toBeCloseTo(200, 6);
    expect(arrow?.points).toEqual([
      [0, 0],
      [200, 100],
    ]);
  });

  it("does not relayout text for non-bridge containers during scene normalization", () => {
    const normalized = normalizeSceneSnapshot({
      version: 1,
      title: "Board WebMCP Demo",
      elements: [
        {
          id: "user-rect",
          type: "rectangle",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
        },
        {
          id: "user-text",
          type: "text",
          text: "Free text",
          containerId: "user-rect",
          width: 80,
          height: 20,
          x: 111,
          y: 222,
        },
      ],
      appState: {},
    });

    const text = normalized.elements.find((element) => {
      return Boolean(element) && typeof element === "object" && (element as { id?: string }).id === "user-text";
    }) as
      | {
          x?: number;
          y?: number;
        }
      | undefined;

    expect(text?.x).toBe(111);
    expect(text?.y).toBe(222);
  });
});
