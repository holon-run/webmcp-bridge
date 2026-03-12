/**
 * This module implements the structured architecture-diagram domain model and deterministic layout logic.
 * It depends on local example types and is used by app state, WebMCP tools, and unit tests.
 */

import type {
  DiagramDocument,
  DiagramEdge,
  DiagramNode,
  DiagramSelection,
  DiagramSummary,
  LayoutMode,
  LayoutScope,
  NodeKind,
  UpsertEdgeInput,
  UpsertNodeInput,
} from "./types.js";

const DEFAULT_NODE_WIDTH = 260;
const DEFAULT_NODE_HEIGHT = 120;
const GRID_X_GAP = 280;
const GRID_Y_GAP = 180;
const LAYER_Y_GAP = 260;
const LAYER_X_GAP = 380;

function createId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyDocument(): DiagramDocument {
  return {
    version: 1,
    nodes: [],
    edges: [],
  };
}

export function createDemoDocument(): DiagramDocument {
  return {
    version: 1,
    nodes: [
      {
        id: "agent",
        label: "Codex / Claude Code / OpenCode",
        kind: "actor",
        x: 80,
        y: 220,
        width: 340,
        height: 120,
      },
      {
        id: "uxc",
        label: "UXC",
        kind: "service",
        x: 480,
        y: 220,
        width: 260,
        height: 120,
        style: {
          strokeColor: "#0f766e",
          backgroundColor: "#ccfbf1",
          textColor: "#115e59",
          fillStyle: "solid",
          roughness: 0,
          opacity: 100,
        },
      },
      {
        id: "local-mcp",
        label: "local-mcp",
        kind: "service",
        x: 780,
        y: 220,
        width: 260,
        height: 120,
        style: {
          strokeColor: "#0f766e",
          backgroundColor: "#ccfbf1",
          textColor: "#115e59",
          fillStyle: "solid",
          roughness: 0,
          opacity: 100,
        },
      },
      {
        id: "playwright",
        label: "playwright",
        kind: "service",
        x: 1140,
        y: 220,
        width: 260,
        height: 120,
        style: {
          strokeColor: "#0f766e",
          backgroundColor: "#ccfbf1",
          textColor: "#115e59",
          fillStyle: "solid",
          roughness: 0,
          opacity: 100,
        },
      },
      {
        id: "model-context",
        label: "native WebMCP",
        kind: "service",
        x: 1600,
        y: 90,
        width: 300,
        height: 120,
        style: {
          strokeColor: "#2563eb",
          backgroundColor: "#dbeafe",
          textColor: "#1d4ed8",
          fillStyle: "solid",
          roughness: 0,
          opacity: 100,
        },
      },
      {
        id: "adapter-shim",
        label: "injected WebMCP",
        kind: "service",
        x: 1600,
        y: 360,
        width: 300,
        height: 120,
        style: {
          strokeColor: "#ea580c",
          backgroundColor: "#ffedd5",
          textColor: "#c2410c",
          fillStyle: "solid",
          roughness: 0,
          opacity: 100,
        },
      },
      {
        id: "website",
        label: "website",
        kind: "external",
        x: 2040,
        y: 225,
        width: 320,
        height: 120,
        style: {
          strokeColor: "#94a3b8",
          backgroundColor: "#f8fafc",
          textColor: "#334155",
          fillStyle: "solid",
          roughness: 0,
          opacity: 85,
        },
      },
    ],
    edges: [
      {
        id: "e-agent-uxc",
        sourceNodeId: "agent",
        targetNodeId: "uxc",
        style: {
          strokeColor: "#334155",
          strokeStyle: "solid",
          strokeWidth: 2,
          opacity: 90,
        },
      },
      {
        id: "e-uxc-local",
        sourceNodeId: "uxc",
        targetNodeId: "local-mcp",
        style: {
          strokeColor: "#334155",
          strokeStyle: "solid",
          strokeWidth: 2,
          opacity: 90,
        },
      },
      {
        id: "e-local-playwright",
        sourceNodeId: "local-mcp",
        targetNodeId: "playwright",
        style: {
          strokeColor: "#334155",
          strokeStyle: "solid",
          strokeWidth: 2,
          opacity: 90,
        },
      },
      {
        id: "e-playwright-native",
        sourceNodeId: "playwright",
        targetNodeId: "model-context",
        label: "native",
        style: {
          strokeColor: "#2563eb",
          textColor: "#1d4ed8",
          strokeStyle: "solid",
          strokeWidth: 3,
          opacity: 100,
        },
      },
      {
        id: "e-playwright-shim",
        sourceNodeId: "playwright",
        targetNodeId: "adapter-shim",
        label: "shim",
        style: {
          strokeColor: "#ea580c",
          textColor: "#c2410c",
          strokeStyle: "dashed",
          strokeWidth: 3,
          opacity: 100,
        },
      },
      {
        id: "e-native-site",
        sourceNodeId: "model-context",
        targetNodeId: "website",
        style: {
          strokeColor: "#334155",
          strokeStyle: "solid",
          strokeWidth: 2,
          opacity: 90,
        },
      },
      {
        id: "e-legacy-site",
        sourceNodeId: "adapter-shim",
        targetNodeId: "website",
        style: {
          strokeColor: "#334155",
          strokeStyle: "solid",
          strokeWidth: 2,
          opacity: 90,
        },
      },
    ],
  };
}

export function summarizeDocument(document: DiagramDocument): DiagramSummary {
  const kinds: Record<NodeKind, number> = {
    actor: 0,
    service: 0,
    database: 0,
    queue: 0,
    cache: 0,
    external: 0,
  };
  for (const node of document.nodes) {
    kinds[node.kind] += 1;
  }
  return {
    nodeCount: document.nodes.length,
    edgeCount: document.edges.length,
    kinds,
  };
}

export function getNodeCenter(node: DiagramNode): { x: number; y: number } {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

export function upsertNodes(document: DiagramDocument, inputs: UpsertNodeInput[]): DiagramDocument {
  const nextNodes = [...document.nodes];
  for (const input of inputs) {
    const index = nextNodes.findIndex((node) => node.id === input.id);
    if (index >= 0) {
      const current = nextNodes[index];
      if (!current) {
        continue;
      }
      const updated: DiagramNode = {
        ...current,
        label: input.label,
        kind: input.kind,
        x: input.x ?? current.x,
        y: input.y ?? current.y,
      };
      if (input.description !== undefined) {
        updated.description = input.description;
      } else {
        delete updated.description;
      }
      nextNodes[index] = updated;
      continue;
    }
    const created: DiagramNode = {
      id: input.id ?? createId("node"),
      label: input.label,
      kind: input.kind,
      x: input.x ?? nextNodes.length * 40,
      y: input.y ?? nextNodes.length * 40,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    };
    if (input.description !== undefined) {
      created.description = input.description;
    }
    nextNodes.push(created);
  }
  return {
    ...document,
    nodes: nextNodes,
  };
}

export function upsertEdges(document: DiagramDocument, inputs: UpsertEdgeInput[]): DiagramDocument {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const nextEdges = [...document.edges];
  for (const input of inputs) {
    if (!nodeIds.has(input.sourceNodeId) || !nodeIds.has(input.targetNodeId)) {
      throw new Error(`edge references missing node: ${input.sourceNodeId} -> ${input.targetNodeId}`);
    }
    const index = nextEdges.findIndex((edge) => edge.id === input.id);
    if (index >= 0) {
      const current = nextEdges[index];
      if (!current) {
        continue;
      }
      const updated: DiagramEdge = {
        ...current,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
      };
      if (input.label !== undefined) {
        updated.label = input.label;
      } else {
        delete updated.label;
      }
      if (input.protocol !== undefined) {
        updated.protocol = input.protocol;
      } else {
        delete updated.protocol;
      }
      nextEdges[index] = updated;
      continue;
    }
    const created: DiagramEdge = {
      id: input.id ?? createId("edge"),
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
    };
    if (input.label !== undefined) {
      created.label = input.label;
    }
    if (input.protocol !== undefined) {
      created.protocol = input.protocol;
    }
    nextEdges.push(created);
  }
  return {
    ...document,
    edges: nextEdges,
  };
}

export function removeDanglingEdges(document: DiagramDocument): DiagramDocument {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  return {
    ...document,
    edges: document.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)),
  };
}

export function removeBySelection(document: DiagramDocument, selection: DiagramSelection): DiagramDocument {
  const nodeIds = new Set(selection.nodeIds);
  const edgeIds = new Set(selection.edgeIds);
  const withoutNodes = document.nodes.filter((node) => !nodeIds.has(node.id));
  const survivingNodeIds = new Set(withoutNodes.map((node) => node.id));
  const withoutEdges = document.edges.filter((edge) => {
    if (edgeIds.has(edge.id)) {
      return false;
    }
    return survivingNodeIds.has(edge.sourceNodeId) && survivingNodeIds.has(edge.targetNodeId);
  });
  return {
    ...document,
    nodes: withoutNodes,
    edges: withoutEdges,
  };
}

export function removeNodesById(document: DiagramDocument, nodeIds: readonly string[]): DiagramDocument {
  const selectedNodeIds = new Set(nodeIds);
  const withoutNodes = document.nodes.filter((node) => !selectedNodeIds.has(node.id));
  const survivingNodeIds = new Set(withoutNodes.map((node) => node.id));
  return {
    ...document,
    nodes: withoutNodes,
    edges: document.edges.filter((edge) => survivingNodeIds.has(edge.sourceNodeId) && survivingNodeIds.has(edge.targetNodeId)),
  };
}

export function removeEdgesById(document: DiagramDocument, edgeIds: readonly string[]): DiagramDocument {
  const selectedEdgeIds = new Set(edgeIds);
  return {
    ...document,
    edges: document.edges.filter((edge) => !selectedEdgeIds.has(edge.id)),
  };
}

function sortNodesForLayout(nodes: DiagramNode[]): DiagramNode[] {
  return [...nodes].sort((left, right) => left.label.localeCompare(right.label));
}

function layoutGrid(document: DiagramDocument, scope: LayoutScope, selection: DiagramSelection): DiagramDocument {
  const selected = new Set(selection.nodeIds);
  const nextNodes = sortNodesForLayout(document.nodes).map((node, index) => {
    if (scope === "selection" && !selected.has(node.id)) {
      return node;
    }
    const selectedIndex =
      scope === "selection"
        ? sortNodesForLayout(document.nodes.filter((candidate) => selected.has(candidate.id))).findIndex(
            (candidate) => candidate.id === node.id,
          )
        : index;
    const column = selectedIndex % 3;
    const row = Math.floor(selectedIndex / 3);
    return {
      ...node,
      x: 80 + column * GRID_X_GAP,
      y: 80 + row * GRID_Y_GAP,
    };
  });
  return {
    ...document,
    nodes: nextNodes,
  };
}

function buildLayerMap(document: DiagramDocument): Map<string, number> {
  const incoming = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of document.nodes) {
    incoming.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of document.edges) {
    adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
  }

  const queue = [...document.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id)];
  const layers = new Map<string, number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const layer = layers.get(current) ?? 0;
    for (const next of adjacency.get(current) ?? []) {
      layers.set(next, Math.max(layers.get(next) ?? 0, layer + 1));
      incoming.set(next, (incoming.get(next) ?? 1) - 1);
      if ((incoming.get(next) ?? 0) <= 0) {
        queue.push(next);
      }
    }
  }
  for (const node of document.nodes) {
    if (!layers.has(node.id)) {
      layers.set(node.id, 0);
    }
  }
  return layers;
}

function layoutLayered(document: DiagramDocument, scope: LayoutScope, selection: DiagramSelection): DiagramDocument {
  if (scope === "selection") {
    return layoutGrid(document, scope, selection);
  }
  const layers = buildLayerMap(document);
  const layerGroups = new Map<number, DiagramNode[]>();
  for (const node of sortNodesForLayout(document.nodes)) {
    const layer = layers.get(node.id) ?? 0;
    const bucket = layerGroups.get(layer) ?? [];
    bucket.push(node);
    layerGroups.set(layer, bucket);
  }
  const nextNodes = document.nodes.map((node) => {
    const layer = layers.get(node.id) ?? 0;
    const nodesInLayer = layerGroups.get(layer) ?? [node];
    const index = nodesInLayer.findIndex((candidate) => candidate.id === node.id);
    return {
      ...node,
      x: 80 + layer * LAYER_X_GAP,
      y: 100 + index * LAYER_Y_GAP,
    };
  });
  return {
    ...document,
    nodes: nextNodes,
  };
}

export function applyLayout(
  document: DiagramDocument,
  mode: LayoutMode,
  scope: LayoutScope,
  selection: DiagramSelection,
): DiagramDocument {
  if (mode === "grid") {
    return layoutGrid(document, scope, selection);
  }
  return layoutLayered(document, scope, selection);
}
