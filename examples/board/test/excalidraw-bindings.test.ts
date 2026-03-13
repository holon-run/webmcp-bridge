/**
 * This module verifies programmatic Excalidraw arrows are bound to node shapes instead of only matching geometry.
 * It depends on the scene conversion helpers so bridge-managed edges keep native editor attachment behavior.
 */

import { documentToSceneElements } from "../src/excalidraw.js";

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
});
