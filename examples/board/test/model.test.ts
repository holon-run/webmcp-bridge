/**
 * This module covers the pure diagram model helpers for the native board example.
 * It depends on the example model implementation so layout and upsert behavior stay deterministic.
 */

import { applyLayout, createDemoDocument, createEmptyDocument, upsertEdges, upsertNodes } from "../src/model.js";

describe("board model", () => {
  it("upserts nodes and edges into a structured document", () => {
    const withNodes = upsertNodes(createEmptyDocument(), [
      { id: "a", label: "Gateway", kind: "service", x: 10, y: 20 },
      { id: "b", label: "DB", kind: "database", x: 20, y: 40 },
    ]);
    const withEdges = upsertEdges(withNodes, [
      { id: "edge1", sourceNodeId: "a", targetNodeId: "b", protocol: "sql" },
    ]);

    expect(withEdges.nodes).toHaveLength(2);
    expect(withEdges.edges).toEqual([
      {
        id: "edge1",
        sourceNodeId: "a",
        targetNodeId: "b",
        protocol: "sql",
      },
    ]);
  });

  it("applies a deterministic layered layout", () => {
    const document = createDemoDocument();
    const laidOut = applyLayout(document, "layered", "all", { nodeIds: [], edgeIds: [] });

    expect(laidOut.nodes.map((node) => node.x)).toContain(80);
    expect(laidOut.nodes.every((node) => Number.isFinite(node.y))).toBe(true);
  });
});
