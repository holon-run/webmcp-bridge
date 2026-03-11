/**
 * This module converts the structured diagram model to and from Excalidraw scene elements.
 * It depends on the example's model/types modules and is used only by the React app layer.
 */

import type { DiagramDocument, DiagramNode, ExcalidrawCustomData } from "./types.js";
import { getNodeCenter } from "./model.js";

const ExcalidrawLibPromise = import("@excalidraw/excalidraw");

function createNodeStyle(node: DiagramNode): Record<string, unknown> {
  const palette: Record<DiagramNode["kind"], { strokeColor: string; backgroundColor: string }> = {
    actor: { strokeColor: "#7c3aed", backgroundColor: "#f3e8ff" },
    service: { strokeColor: "#0f766e", backgroundColor: "#ccfbf1" },
    database: { strokeColor: "#1d4ed8", backgroundColor: "#dbeafe" },
    queue: { strokeColor: "#b45309", backgroundColor: "#fef3c7" },
    cache: { strokeColor: "#be123c", backgroundColor: "#ffe4e6" },
    external: { strokeColor: "#475569", backgroundColor: "#e2e8f0" },
  };
  return palette[node.kind];
}

function createCustomData(bridgeType: ExcalidrawCustomData["bridgeType"], bridgeId: string): ExcalidrawCustomData {
  return {
    bridgeType,
    bridgeId,
  };
}

export async function documentToSceneElements(document: DiagramDocument): Promise<unknown[]> {
  const excalidrawLib = await ExcalidrawLibPromise;
  const convertToExcalidrawElements = (
    excalidrawLib as unknown as {
      convertToExcalidrawElements: (elements: unknown[]) => unknown[];
    }
  ).convertToExcalidrawElements;

  const skeletons: unknown[] = [];
  for (const node of document.nodes) {
    skeletons.push({
      type: "rectangle",
      id: `node-shape-${node.id}`,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      roundness: { type: 3 },
      customData: createCustomData("node", node.id),
      ...createNodeStyle(node),
    });
    skeletons.push({
      type: "text",
      id: `node-label-${node.id}`,
      x: node.x + 24,
      y: node.y + 40,
      text: node.label,
      fontSize: 28,
      fontFamily: 5,
      width: Math.max(120, node.width - 48),
      customData: createCustomData("node", node.id),
      strokeColor: "#0f172a",
      textAlign: "center",
      verticalAlign: "middle",
    });
  }

  for (const edge of document.edges) {
    const source = document.nodes.find((node) => node.id === edge.sourceNodeId);
    const target = document.nodes.find((node) => node.id === edge.targetNodeId);
    if (!source || !target) {
      continue;
    }
    const from = getNodeCenter(source);
    const to = getNodeCenter(target);
    skeletons.push({
      type: "arrow",
      id: `edge-line-${edge.id}`,
      x: from.x,
      y: from.y,
      points: [
        [0, 0],
        [to.x - from.x, to.y - from.y],
      ],
      startArrowhead: null,
      endArrowhead: "arrow",
      strokeColor: "#0f172a",
      customData: createCustomData("edge", edge.id),
    });
    if (edge.label || edge.protocol) {
      skeletons.push({
        type: "text",
        id: `edge-label-${edge.id}`,
        x: from.x + (to.x - from.x) / 2 - 40,
        y: from.y + (to.y - from.y) / 2 - 12,
        text: edge.protocol ? `${edge.protocol}${edge.label ? ` (${edge.label})` : ""}` : (edge.label ?? ""),
        fontSize: 20,
        fontFamily: 5,
        customData: createCustomData("edge-label", edge.id),
        strokeColor: "#334155",
      });
    }
  }

  return convertToExcalidrawElements(skeletons);
}

function readBridgeData(element: unknown): ExcalidrawCustomData | undefined {
  if (!element || typeof element !== "object") {
    return undefined;
  }
  const customData = (element as { customData?: unknown }).customData;
  if (!customData || typeof customData !== "object") {
    return undefined;
  }
  const bridgeType = (customData as { bridgeType?: unknown }).bridgeType;
  const bridgeId = (customData as { bridgeId?: unknown }).bridgeId;
  if (
    (bridgeType === "node" || bridgeType === "edge" || bridgeType === "edge-label") &&
    typeof bridgeId === "string" &&
    bridgeId.length > 0
  ) {
    return {
      bridgeType,
      bridgeId,
    };
  }
  return undefined;
}

export function syncNodePositionsFromScene(document: DiagramDocument, elements: readonly unknown[]): DiagramDocument {
  const positions = new Map<string, { x: number; y: number }>();
  for (const element of elements) {
    const bridgeData = readBridgeData(element);
    if (!bridgeData || bridgeData.bridgeType !== "node") {
      continue;
    }
    const typed = element as { type?: unknown; x?: unknown; y?: unknown };
    if (typed.type !== "rectangle" || typeof typed.x !== "number" || typeof typed.y !== "number") {
      continue;
    }
    positions.set(bridgeData.bridgeId, { x: typed.x, y: typed.y });
  }

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const position = positions.get(node.id);
      if (!position) {
        return node;
      }
      return {
        ...node,
        x: position.x,
        y: position.y,
      };
    }),
  };
}

export function extractSelection(elements: readonly unknown[], selectedIds: ReadonlySet<string>) {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const element of elements) {
    if (!element || typeof element !== "object") {
      continue;
    }
    const id = (element as { id?: unknown }).id;
    if (typeof id !== "string" || !selectedIds.has(id)) {
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (!bridgeData) {
      continue;
    }
    if (bridgeData.bridgeType === "node") {
      nodeIds.add(bridgeData.bridgeId);
      continue;
    }
    if (bridgeData.bridgeType === "edge" || bridgeData.bridgeType === "edge-label") {
      edgeIds.add(bridgeData.bridgeId);
    }
  }

  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
  };
}
