/**
 * This module converts the structured diagram model to and from Excalidraw scene elements.
 * It depends on the example's model/types modules and is used only by the React app layer.
 */

import type { DiagramDocument, DiagramEdge, DiagramNode, ExcalidrawCustomData } from "./types.js";

const ExcalidrawLibPromise = import("@excalidraw/excalidraw");
const NODE_SHAPE_PREFIX = "node-shape-";
const NODE_LABEL_PREFIX = "node-label-";
const EDGE_LINE_PREFIX = "edge-line-";
const EDGE_LABEL_PREFIX = "edge-label-";

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

function getNodeCenter(node: DiagramNode): { x: number; y: number } {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function projectToNodeBoundary(node: DiagramNode, toward: { x: number; y: number }): { x: number; y: number } {
  const center = getNodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;

  if (dx === 0 && dy === 0) {
    return center;
  }

  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
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
      id: `${NODE_SHAPE_PREFIX}${node.id}`,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      roundness: { type: 3 },
      label: {
        text: node.label,
        fontSize: 22,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "middle",
        strokeColor: "#0f172a",
      },
      customData: createCustomData("node", node.id),
      ...createNodeStyle(node),
    });
  }

  for (const edge of document.edges) {
    const source = document.nodes.find((node) => node.id === edge.sourceNodeId);
    const target = document.nodes.find((node) => node.id === edge.targetNodeId);
    if (!source || !target) {
      continue;
    }
    const sourceCenter = getNodeCenter(source);
    const targetCenter = getNodeCenter(target);
    const from = projectToNodeBoundary(source, targetCenter);
    const to = projectToNodeBoundary(target, sourceCenter);
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
      label:
        edge.label || edge.protocol
          ? {
              text: edge.protocol ? `${edge.protocol}${edge.label ? ` (${edge.label})` : ""}` : (edge.label ?? ""),
              fontSize: 20,
              fontFamily: 5,
              textAlign: "center",
              verticalAlign: "middle",
              strokeColor: "#334155",
            }
          : undefined,
      strokeColor: "#0f172a",
      customData: createCustomData("edge", edge.id),
    });
  }

  return convertToExcalidrawElements(skeletons);
}

function decodeBridgeDataFromElementId(elementId: string): ExcalidrawCustomData | undefined {
  if (elementId.startsWith(NODE_SHAPE_PREFIX)) {
    return {
      bridgeType: "node",
      bridgeId: elementId.slice(NODE_SHAPE_PREFIX.length),
    };
  }
  if (elementId.startsWith(NODE_LABEL_PREFIX)) {
    return {
      bridgeType: "node",
      bridgeId: elementId.slice(NODE_LABEL_PREFIX.length),
    };
  }
  if (elementId.startsWith(EDGE_LINE_PREFIX)) {
    return {
      bridgeType: "edge",
      bridgeId: elementId.slice(EDGE_LINE_PREFIX.length),
    };
  }
  if (elementId.startsWith(EDGE_LABEL_PREFIX)) {
    return {
      bridgeType: "edge-label",
      bridgeId: elementId.slice(EDGE_LABEL_PREFIX.length),
    };
  }
  return undefined;
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
  const elementId = readElementId(element);
  return elementId ? decodeBridgeDataFromElementId(elementId) : undefined;
}

function readElementId(element: unknown): string | undefined {
  if (!element || typeof element !== "object") {
    return undefined;
  }
  const value = (element as { id?: unknown }).id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeLabelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isDeleted(element: unknown): boolean {
  if (!element || typeof element !== "object") {
    return false;
  }
  return (element as { isDeleted?: unknown }).isDeleted === true;
}

function getTextForContainer(elements: readonly unknown[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const element of elements) {
    if (!element || typeof element !== "object" || isDeleted(element)) {
      continue;
    }
    const typed = element as {
      type?: unknown;
      text?: unknown;
      containerId?: unknown;
      customData?: unknown;
    };
    if (typed.type !== "text" || typeof typed.text !== "string" || !typed.text.trim()) {
      continue;
    }
    if (typeof typed.containerId === "string" && typed.containerId.length > 0) {
      labels.set(typed.containerId, normalizeLabelText(typed.text));
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (bridgeData?.bridgeType === "node") {
      labels.set(`bridge:${bridgeData.bridgeId}`, normalizeLabelText(typed.text));
    }
  }
  return labels;
}

type TextEntry = {
  text: string;
  x: number;
  y: number;
};

function collectFreeTextEntries(elements: readonly unknown[]): TextEntry[] {
  const entries: TextEntry[] = [];
  for (const element of elements) {
    if (!element || typeof element !== "object" || isDeleted(element)) {
      continue;
    }
    const typed = element as {
      type?: unknown;
      text?: unknown;
      x?: unknown;
      y?: unknown;
      containerId?: unknown;
    };
    if (
      typed.type !== "text" ||
      typeof typed.text !== "string" ||
      !typed.text.trim() ||
      typeof typed.x !== "number" ||
      typeof typed.y !== "number" ||
      typeof typed.containerId === "string"
    ) {
      continue;
    }
    entries.push({
      text: normalizeLabelText(typed.text),
      x: typed.x,
      y: typed.y,
    });
  }
  return entries;
}

type RectBounds = { x: number; y: number; width: number; height: number };

function isPointInsideRect(rectangle: RectBounds, x: number, y: number): boolean {
  return x >= rectangle.x && x <= rectangle.x + rectangle.width && y >= rectangle.y && y <= rectangle.y + rectangle.height;
}

function findTextInsideRectangle(textEntries: readonly TextEntry[], rectangle: RectBounds): string | undefined {
  return textEntries.find((entry) => isPointInsideRect(rectangle, entry.x, entry.y))?.text;
}

function matchPreviousNodeByGeometry(
  previousNodes: ReadonlyMap<string, DiagramNode>,
  rectangle: { x: number; y: number; width: number; height: number },
): DiagramNode | undefined {
  for (const node of previousNodes.values()) {
    if (
      Math.abs(node.x - rectangle.x) < 1 &&
      Math.abs(node.y - rectangle.y) < 1 &&
      Math.abs(node.width - rectangle.width) < 1 &&
      Math.abs(node.height - rectangle.height) < 1
    ) {
      return node;
    }
  }
  return undefined;
}

function inferNodeKind(label: string | undefined): DiagramNode["kind"] {
  const normalized = (label ?? "").toLowerCase();
  if (normalized.includes("db") || normalized.includes("database")) {
    return "database";
  }
  if (normalized.includes("queue") || normalized.includes("bus")) {
    return "queue";
  }
  if (normalized.includes("cache")) {
    return "cache";
  }
  if (normalized.includes("user") || normalized.includes("human") || normalized.includes("agent") || normalized.includes("client")) {
    return "actor";
  }
  if (normalized.includes("site") || normalized.includes("browser") || normalized.includes("external")) {
    return "external";
  }
  return "service";
}

function readArrowEndpoints(element: unknown): { startX: number; startY: number; endX: number; endY: number } | undefined {
  if (!element || typeof element !== "object") {
    return undefined;
  }
  const typed = element as { type?: unknown; x?: unknown; y?: unknown; points?: unknown };
  if (typed.type !== "arrow" || typeof typed.x !== "number" || typeof typed.y !== "number" || !Array.isArray(typed.points)) {
    return undefined;
  }
  const lastPoint = typed.points[typed.points.length - 1];
  if (!Array.isArray(lastPoint) || typeof lastPoint[0] !== "number" || typeof lastPoint[1] !== "number") {
    return undefined;
  }
  return {
    startX: typed.x,
    startY: typed.y,
    endX: typed.x + lastPoint[0],
    endY: typed.y + lastPoint[1],
  };
}

function containsPoint(node: DiagramNode, x: number, y: number): boolean {
  return x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height;
}

export function sceneElementsToDocument(previous: DiagramDocument, elements: readonly unknown[]): DiagramDocument {
  const textForContainer = getTextForContainer(elements);
  const freeTextEntries = collectFreeTextEntries(elements);
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nodes: DiagramNode[] = [];

  for (const element of elements) {
    if (!element || typeof element !== "object" || isDeleted(element)) {
      continue;
    }
    const typed = element as {
      type?: unknown;
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (
      typed.type !== "rectangle" ||
      typeof typed.x !== "number" ||
      typeof typed.y !== "number" ||
      typeof typed.width !== "number" ||
      typeof typed.height !== "number"
    ) {
      continue;
    }
    const bridgeData = readBridgeData(element);
    const rectangle: RectBounds = {
      x: typed.x,
      y: typed.y,
      width: typed.width,
      height: typed.height,
    };
    const geometryMatch = matchPreviousNodeByGeometry(previousNodes, rectangle);
    const rawId =
      bridgeData?.bridgeType === "node" ? bridgeData.bridgeId : geometryMatch?.id ?? readElementId(element);
    if (!rawId) {
      continue;
    }
    const existing = previousNodes.get(rawId) ?? geometryMatch;
    const label =
      textForContainer.get(readElementId(element) ?? "") ??
      textForContainer.get(`bridge:${rawId}`) ??
      findTextInsideRectangle(freeTextEntries, rectangle) ??
      existing?.label ??
      "Untitled";

    const nextNode: DiagramNode = {
      id: rawId,
      label,
      kind: existing?.kind ?? inferNodeKind(label),
      x: typed.x,
      y: typed.y,
      width: typed.width,
      height: typed.height,
    };
    if (existing?.description !== undefined) {
      nextNode.description = existing.description;
    }
    nodes.push(nextNode);
  }

  const mergedNodesMap = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    mergedNodesMap.set(node.id, node);
  }
  const mergedNodes = [...mergedNodesMap.values()];
  const nodeById = new Map(mergedNodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const edges: DiagramEdge[] = [];

  for (const element of elements) {
    if (!element || typeof element !== "object" || isDeleted(element)) {
      continue;
    }
    const bridgeData = readBridgeData(element);
    const edgeId = bridgeData?.bridgeType === "edge" ? bridgeData.bridgeId : readElementId(element);
    const endpoints = readArrowEndpoints(element);
    if (!edgeId || !endpoints) {
      continue;
    }
    const source = nodes.find((node) => containsPoint(node, endpoints.startX, endpoints.startY));
    const target = nodes.find((node) => containsPoint(node, endpoints.endX, endpoints.endY));
    if (!source || !target || source.id === target.id) {
      continue;
    }
    const existing = previousEdges.get(edgeId);
    const nextEdge: DiagramEdge = {
      id: edgeId,
      sourceNodeId: source.id,
      targetNodeId: target.id,
    };
    if (existing?.label !== undefined) {
      nextEdge.label = existing.label;
    }
    if (existing?.protocol !== undefined) {
      nextEdge.protocol = existing.protocol;
    }
    edges.push(nextEdge);
  }

  const mergedEdgesMap = new Map(
    previous.edges
      .filter((edge) => nodeById.has(edge.sourceNodeId) && nodeById.has(edge.targetNodeId))
      .map((edge) => [edge.id, edge]),
  );
  for (const edge of edges) {
    mergedEdgesMap.set(edge.id, edge);
  }
  const nextEdges = [...mergedEdgesMap.values()];

  return {
    version: 1,
    nodes: mergedNodes,
    edges: nextEdges,
  };
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
