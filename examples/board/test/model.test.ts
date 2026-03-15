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

  it("supports partial patch updates for existing nodes and edges", () => {
    const document = upsertEdges(
      upsertNodes(createEmptyDocument(), [
        { id: "a", label: "Gateway", kind: "service", x: 10, y: 20 },
        { id: "b", label: "DB", kind: "database", x: 20, y: 40 },
      ]),
      [{ id: "edge1", sourceNodeId: "a", targetNodeId: "b", protocol: "sql" }],
    );

    const patchedNodes = upsertNodes(document, [{ id: "a", x: 120, y: 180 }]);
    expect(patchedNodes.nodes.find((node) => node.id === "a")).toMatchObject({
      id: "a",
      label: "Gateway",
      kind: "service",
      x: 120,
      y: 180,
    });

    const patchedEdges = upsertEdges(patchedNodes, [{ id: "edge1", label: "primary path" }]);
    expect(patchedEdges.edges.find((edge) => edge.id === "edge1")).toMatchObject({
      id: "edge1",
      sourceNodeId: "a",
      targetNodeId: "b",
      label: "primary path",
      protocol: "sql",
    });
  });
});
