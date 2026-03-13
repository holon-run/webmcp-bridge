/**
 * This module derives bridge-managed graph data from Excalidraw scene snapshots and applies scene-first mutations.
 * It depends on the pure model helpers and is used by both the React UI and WebMCP tools.
 */

import {
  applyLayout,
  createDemoDocument,
  removeBySelection,
  removeDanglingEdges,
  summarizeDocument,
  upsertEdges,
  upsertNodes,
  removeEdgesById,
  removeNodesById,
} from "./model.js";
import type {
  BoardSceneAppState,
  BoardSceneSnapshot,
  CanvasStylePatch,
  DiagramDocument,
  DiagramEdge,
  DiagramEdgeStyle,
  DiagramNode,
  DiagramNodeStyle,
  DiagramSelection,
  DiagramSummary,
  EdgeStylePatch,
  ExcalidrawCustomData,
  ExcalidrawEdgeCustomData,
  ExcalidrawNodeCustomData,
  LayoutMode,
  LayoutScope,
  NodeStylePatch,
  ResizeNodeInput,
  UpsertEdgeInput,
  UpsertNodeInput,
} from "./types.js";

const DEFAULT_SCENE_BACKGROUND = "#f7fee7";
const NODE_SHAPE_PREFIX = "node-shape-";
const EDGE_LINE_PREFIX = "edge-line-";

type RawElement = Record<string, unknown>;

type ExcalidrawSkeletonLabel = {
  text?: string;
};

type ExcalidrawSkeleton = {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: ExcalidrawSkeletonLabel;
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneElement<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fallbackConvertToExcalidrawElements(elements: unknown[]): unknown[] {
  const converted: unknown[] = [];
  for (const item of elements) {
    if (!isRecord(item)) {
      converted.push(item);
      continue;
    }
    const skeleton = item as ExcalidrawSkeleton;
    const labelText = typeof skeleton.label?.text === "string" ? skeleton.label.text : undefined;
    const shape = { ...skeleton };
    delete shape.label;
    if (shape.type === "arrow" && isRecord(shape.start) && isRecord(shape.end)) {
      const startX = typeof shape.x === "number" ? shape.x : 0;
      const startY = typeof shape.y === "number" ? shape.y : 0;
      const endX = typeof shape.end.x === "number" ? shape.end.x : startX;
      const endY = typeof shape.end.y === "number" ? shape.end.y : startY;
      shape.points = [
        [0, 0],
        [endX - startX, endY - startY],
      ];
    }
    delete shape.start;
    delete shape.end;
    converted.push(shape);
    if (labelText && typeof skeleton.id === "string") {
      converted.push({
        id: `${skeleton.id}-label`,
        type: "text",
        text: labelText,
        containerId: skeleton.id,
        x: typeof skeleton.x === "number" ? skeleton.x + 24 : 0,
        y: typeof skeleton.y === "number" ? skeleton.y + 24 : 0,
      });
    }
  }
  return converted;
}

async function loadConvertToExcalidrawElements(): Promise<(elements: unknown[]) => unknown[]> {
  try {
    const excalidrawLib = await import("@excalidraw/excalidraw");
    return (
      excalidrawLib as unknown as {
        convertToExcalidrawElements: (elements: unknown[]) => unknown[];
      }
    ).convertToExcalidrawElements;
  } catch {
    return fallbackConvertToExcalidrawElements;
  }
}

function isDeleted(element: unknown): boolean {
  return isRecord(element) && element.isDeleted === true;
}

function normalizeElements(elements: readonly unknown[]): unknown[] {
  return elements.filter((element) => !isDeleted(element)).map((element) => cloneElement(element));
}

function readBoundElements(element: unknown): Array<{ id: string; type: "arrow" | "text" }> {
  if (!isRecord(element) || !Array.isArray(element.boundElements)) {
    return [];
  }
  return element.boundElements.flatMap((value) => {
    if (
      isRecord(value) &&
      typeof value.id === "string" &&
      (value.type === "arrow" || value.type === "text")
    ) {
      return [{ id: value.id, type: value.type }];
    }
    return [];
  });
}

function normalizeLabelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function positionTextInContainer(container: RawElement, text: RawElement): void {
  if (
    typeof container.x !== "number" ||
    typeof container.y !== "number" ||
    typeof container.width !== "number" ||
    typeof container.height !== "number" ||
    typeof text.width !== "number" ||
    typeof text.height !== "number"
  ) {
    return;
  }
  text.x = container.x + (container.width - text.width) / 2;
  text.y = container.y + (container.height - text.height) / 2;
}

function readArrowLineEndpoints(arrow: RawElement): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
  if (typeof arrow.x !== "number" || typeof arrow.y !== "number" || !Array.isArray(arrow.points) || arrow.points.length === 0) {
    return undefined;
  }
  const firstPoint = readLocalPoint(arrow.points[0]);
  const lastPoint = readLocalPoint(arrow.points[arrow.points.length - 1]);
  if (!firstPoint || !lastPoint) {
    return undefined;
  }
  return {
    start: {
      x: arrow.x + firstPoint[0],
      y: arrow.y + firstPoint[1],
    },
    end: {
      x: arrow.x + lastPoint[0],
      y: arrow.y + lastPoint[1],
    },
  };
}

function readContainerCenter(element: RawElement): { x: number; y: number } | undefined {
  if (
    typeof element.x !== "number" ||
    typeof element.y !== "number" ||
    typeof element.width !== "number" ||
    typeof element.height !== "number"
  ) {
    return undefined;
  }
  return {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
}

function positionArrowLabel(arrow: RawElement, text: RawElement, byId: ReadonlyMap<string, RawElement>): void {
  if (typeof text.width !== "number" || typeof text.height !== "number") {
    return;
  }
  const startContainerId =
    isRecord(arrow.startBinding) && typeof arrow.startBinding.elementId === "string"
      ? arrow.startBinding.elementId
      : undefined;
  const endContainerId =
    isRecord(arrow.endBinding) && typeof arrow.endBinding.elementId === "string"
      ? arrow.endBinding.elementId
      : undefined;
  const boundStart = startContainerId ? byId.get(startContainerId) : undefined;
  const boundEnd = endContainerId ? byId.get(endContainerId) : undefined;
  const startCenter = boundStart ? readContainerCenter(boundStart) : undefined;
  const endCenter = boundEnd ? readContainerCenter(boundEnd) : undefined;
  const endpoints =
    startCenter && endCenter
      ? { start: startCenter, end: endCenter }
      : readArrowLineEndpoints(arrow);
  if (!endpoints) {
    return;
  }
  const dx = endpoints.end.x - endpoints.start.x;
  const dy = endpoints.end.y - endpoints.start.y;
  const length = Math.hypot(dx, dy);
  const normalX = length === 0 ? 0 : -dy / length;
  const normalY = length === 0 ? -1 : dx / length;
  const offset = Math.max(14, text.height * 0.8);
  const centerX = (endpoints.start.x + endpoints.end.x) / 2;
  const centerY = (endpoints.start.y + endpoints.end.y) / 2;
  text.x = centerX - text.width / 2 + normalX * offset;
  text.y = centerY - text.height / 2 + normalY * offset;
}

function layoutConvertedTextElements(elements: unknown[]): unknown[] {
  const byId = new Map<string, RawElement>();
  for (const element of elements) {
    if (!isRecord(element) || typeof element.id !== "string" || isDeleted(element)) {
      continue;
    }
    byId.set(element.id, element);
  }
  for (const element of elements) {
    if (!isRecord(element) || element.type !== "text" || isDeleted(element) || typeof element.containerId !== "string") {
      continue;
    }
    const container = byId.get(element.containerId);
    if (!container) {
      continue;
    }
    if (container.type === "rectangle") {
      positionTextInContainer(container, element);
      continue;
    }
    if (container.type === "arrow") {
      positionArrowLabel(container, element, byId);
    }
  }
  return elements;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readLocalPoint(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }
  const [x, y] = value;
  if (typeof x !== "number" || typeof y !== "number") {
    return undefined;
  }
  return [x, y];
}

function readArrowEndpoint(element: RawElement, side: "start" | "end"): { x: number; y: number } | undefined {
  if (typeof element.x !== "number" || typeof element.y !== "number" || !Array.isArray(element.points) || element.points.length === 0) {
    return undefined;
  }
  const firstPoint = readLocalPoint(element.points[0]);
  const lastPoint = readLocalPoint(element.points[element.points.length - 1]);
  if (!firstPoint || !lastPoint) {
    return undefined;
  }
  const localPoint = side === "start" ? firstPoint : lastPoint;
  return {
    x: element.x + localPoint[0],
    y: element.y + localPoint[1],
  };
}

function createPointBindingForNode(
  nodeElementId: string,
  nodeElement: RawElement,
  point: { x: number; y: number },
): { elementId: string; focus: number; gap: number } | undefined {
  if (
    typeof nodeElement.x !== "number" ||
    typeof nodeElement.y !== "number" ||
    typeof nodeElement.width !== "number" ||
    typeof nodeElement.height !== "number"
  ) {
    return undefined;
  }

  const centerX = nodeElement.x + nodeElement.width / 2;
  const centerY = nodeElement.y + nodeElement.height / 2;
  const halfWidth = nodeElement.width / 2;
  const halfHeight = nodeElement.height / 2;
  const dx = point.x - centerX;
  const dy = point.y - centerY;

  const normalizedX = halfWidth === 0 ? 0 : Math.abs(dx) / halfWidth;
  const normalizedY = halfHeight === 0 ? 0 : Math.abs(dy) / halfHeight;
  const onVerticalSide = normalizedX >= normalizedY;
  const focus = onVerticalSide
    ? clamp(halfHeight === 0 ? 0 : dy / halfHeight, -1, 1)
    : clamp(halfWidth === 0 ? 0 : dx / halfWidth, -1, 1);

  return {
    elementId: nodeElementId,
    focus,
    gap: 0,
  };
}

function attachArrowBindings(elements: unknown[]): unknown[] {
  const byId = new Map<string, RawElement>();
  const nodeElementsByBridgeId = new Map<string, { elementId: string; element: RawElement }>();
  for (const element of elements) {
    if (!isRecord(element) || typeof element.id !== "string" || isDeleted(element)) {
      continue;
    }
    byId.set(element.id, element);
    const bridgeData = readBridgeData(element);
    if (bridgeData?.bridgeType === "node") {
      nodeElementsByBridgeId.set(bridgeData.bridgeId, {
        elementId: element.id,
        element,
      });
    }
  }

  for (const element of elements) {
    if (!isRecord(element) || element.type !== "arrow" || isDeleted(element)) {
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (!bridgeData || bridgeData.bridgeType !== "edge") {
      continue;
    }
    const sourceEntry = nodeElementsByBridgeId.get(bridgeData.sourceNodeId);
    const targetEntry = nodeElementsByBridgeId.get(bridgeData.targetNodeId);
    if (!sourceEntry || !targetEntry || typeof element.id !== "string") {
      continue;
    }
    const source = sourceEntry.element;
    const target = targetEntry.element;
    const startPoint = readArrowEndpoint(element, "start");
    const endPoint = readArrowEndpoint(element, "end");
    const startBinding = startPoint
      ? createPointBindingForNode(sourceEntry.elementId, source, startPoint)
      : undefined;
    const endBinding = endPoint
      ? createPointBindingForNode(targetEntry.elementId, target, endPoint)
      : undefined;
    if (!startBinding || !endBinding) {
      continue;
    }

    element.startBinding = startBinding;
    element.endBinding = endBinding;

    const arrowRef = { id: element.id, type: "arrow" as const };
    const sourceBound = readBoundElements(source);
    if (!sourceBound.some((bound) => bound.id === arrowRef.id && bound.type === arrowRef.type)) {
      source.boundElements = [...sourceBound, arrowRef];
    }
    const targetBound = readBoundElements(target);
    if (!targetBound.some((bound) => bound.id === arrowRef.id && bound.type === arrowRef.type)) {
      target.boundElements = [...targetBound, arrowRef];
    }
  }

  return elements;
}

function readRectangleCenter(element: RawElement): { x: number; y: number } | undefined {
  if (
    typeof element.x !== "number" ||
    typeof element.y !== "number" ||
    typeof element.width !== "number" ||
    typeof element.height !== "number"
  ) {
    return undefined;
  }
  return {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
}

function projectToRectangleBoundary(
  element: RawElement,
  toward: { x: number; y: number },
): { x: number; y: number } | undefined {
  const center = readRectangleCenter(element);
  if (!center || typeof element.width !== "number" || typeof element.height !== "number") {
    return undefined;
  }
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const halfWidth = element.width / 2;
  const halfHeight = element.height / 2;

  if (dx === 0 && dy === 0) {
    return center;
  }

  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
  };
}

function normalizeBridgeArrowGeometry(elements: unknown[]): unknown[] {
  const nodeElementsByBridgeId = new Map<string, RawElement>();
  for (const element of elements) {
    if (!isRecord(element) || isDeleted(element)) {
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (bridgeData?.bridgeType === "node" && element.type === "rectangle") {
      nodeElementsByBridgeId.set(bridgeData.bridgeId, element);
    }
  }

  for (const element of elements) {
    if (!isRecord(element) || isDeleted(element) || element.type !== "arrow") {
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (!bridgeData || bridgeData.bridgeType !== "edge") {
      continue;
    }
    const source = nodeElementsByBridgeId.get(bridgeData.sourceNodeId);
    const target = nodeElementsByBridgeId.get(bridgeData.targetNodeId);
    if (!source || !target) {
      continue;
    }
    const sourceCenter = readRectangleCenter(source);
    const targetCenter = readRectangleCenter(target);
    if (!sourceCenter || !targetCenter) {
      continue;
    }
    const from = projectToRectangleBoundary(source, targetCenter);
    const to = projectToRectangleBoundary(target, sourceCenter);
    if (!from || !to) {
      continue;
    }
    element.x = from.x;
    element.y = from.y;
    element.points = [
      [0, 0],
      [to.x - from.x, to.y - from.y],
    ];
  }

  return elements;
}

export function normalizeSceneSnapshot(snapshot: BoardSceneSnapshot): BoardSceneSnapshot {
  return {
    version: 1,
    elements: layoutConvertedTextElements(
      attachArrowBindings(normalizeBridgeArrowGeometry(normalizeElements(snapshot.elements))),
    ),
    appState: sanitizeAppState(snapshot.appState),
  };
}

function sanitizeAppState(appState: unknown): BoardSceneAppState {
  if (!isRecord(appState)) {
    return {
      viewBackgroundColor: DEFAULT_SCENE_BACKGROUND,
    };
  }
  const rawZoom = appState.zoom;
  const zoom =
    typeof rawZoom === "number"
      ? rawZoom
      : isRecord(rawZoom) && typeof rawZoom.value === "number"
        ? rawZoom.value
        : undefined;
  return {
    viewBackgroundColor: typeof appState.viewBackgroundColor === "string" ? appState.viewBackgroundColor : DEFAULT_SCENE_BACKGROUND,
    ...(typeof appState.scrollX === "number" ? { scrollX: appState.scrollX } : {}),
    ...(typeof appState.scrollY === "number" ? { scrollY: appState.scrollY } : {}),
    ...(typeof zoom === "number" ? { zoom } : {}),
  };
}

export function toExcalidrawAppState(appState: BoardSceneAppState): Record<string, unknown> {
  const next: Record<string, unknown> = {
    viewBackgroundColor: appState.viewBackgroundColor ?? DEFAULT_SCENE_BACKGROUND,
  };
  if (typeof appState.scrollX === "number") {
    next.scrollX = appState.scrollX;
  }
  if (typeof appState.scrollY === "number") {
    next.scrollY = appState.scrollY;
  }
  if (typeof appState.zoom === "number") {
    next.zoom = { value: appState.zoom };
  }
  return next;
}

export function createRawSceneSnapshot(elements: readonly unknown[], appState?: unknown): BoardSceneSnapshot {
  return {
    version: 1,
    elements: normalizeElements(elements),
    appState: sanitizeAppState(appState),
  };
}

export function createSceneSnapshot(elements: readonly unknown[], appState?: unknown): BoardSceneSnapshot {
  return normalizeSceneSnapshot(createRawSceneSnapshot(elements, appState));
}

export function createEmptySceneSnapshot(): BoardSceneSnapshot {
  return {
    version: 1,
    elements: [],
    appState: {
      viewBackgroundColor: DEFAULT_SCENE_BACKGROUND,
    },
  };
}

function createNodeCustomData(node: DiagramNode): ExcalidrawNodeCustomData {
  return {
    bridgeType: "node",
    bridgeId: node.id,
    nodeKind: node.kind,
    ...(node.description !== undefined ? { description: node.description } : {}),
  };
}

function createEdgeCustomData(edge: DiagramEdge): ExcalidrawEdgeCustomData {
  return {
    bridgeType: "edge",
    bridgeId: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    ...(edge.label !== undefined ? { label: edge.label } : {}),
    ...(edge.protocol !== undefined ? { protocol: edge.protocol } : {}),
  };
}

function createNodeStyle(node: DiagramNode): Record<string, unknown> {
  const palette: Record<DiagramNode["kind"], { strokeColor: string; backgroundColor: string }> = {
    actor: { strokeColor: "#7c3aed", backgroundColor: "#f3e8ff" },
    service: { strokeColor: "#0f766e", backgroundColor: "#ccfbf1" },
    database: { strokeColor: "#1d4ed8", backgroundColor: "#dbeafe" },
    queue: { strokeColor: "#b45309", backgroundColor: "#fef3c7" },
    cache: { strokeColor: "#be123c", backgroundColor: "#ffe4e6" },
    external: { strokeColor: "#475569", backgroundColor: "#e2e8f0" },
  };
  return {
    ...palette[node.kind],
    ...(node.style?.strokeColor ? { strokeColor: node.style.strokeColor } : {}),
    ...(node.style?.backgroundColor ? { backgroundColor: node.style.backgroundColor } : {}),
    ...(node.style?.fillStyle ? { fillStyle: node.style.fillStyle } : {}),
    ...(typeof node.style?.roughness === "number" ? { roughness: node.style.roughness } : {}),
    ...(typeof node.style?.opacity === "number" ? { opacity: node.style.opacity } : {}),
  };
}

function formatEdgeText(edge: DiagramEdge): string | undefined {
  if (edge.protocol && edge.label) {
    return `${edge.protocol} (${edge.label})`;
  }
  return edge.protocol ?? edge.label;
}

function getNodeCenter(node: DiagramNode): { x: number; y: number } {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function projectToNodeBoundary(
  node: DiagramNode,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const center = getNodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;

  if (dx === 0 && dy === 0) {
    return center;
  }

  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
  };
}

export async function documentToSceneElements(document: DiagramDocument): Promise<unknown[]> {
  const convertToExcalidrawElements = await loadConvertToExcalidrawElements();

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
        strokeColor: node.style?.textColor ?? "#0f172a",
      },
      customData: createNodeCustomData(node),
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
      id: `${EDGE_LINE_PREFIX}${edge.id}`,
      x: from.x,
      y: from.y,
      points: [
        [0, 0],
        [to.x - from.x, to.y - from.y],
      ],
      startArrowhead: null,
      endArrowhead: "arrow",
      label: formatEdgeText(edge)
        ? {
            text: formatEdgeText(edge),
            fontSize: 20,
            fontFamily: 5,
            textAlign: "center",
            verticalAlign: "middle",
            strokeColor: edge.style?.textColor ?? "#334155",
          }
        : undefined,
      strokeColor: edge.style?.strokeColor ?? "#0f172a",
      ...(edge.style?.strokeStyle ? { strokeStyle: edge.style.strokeStyle } : {}),
      ...(typeof edge.style?.strokeWidth === "number" ? { strokeWidth: edge.style.strokeWidth } : {}),
      ...(typeof edge.style?.opacity === "number" ? { opacity: edge.style.opacity } : {}),
      customData: createEdgeCustomData(edge),
    });
  }

  return layoutConvertedTextElements(attachArrowBindings(convertToExcalidrawElements(skeletons)));
}

export async function createDemoSceneSnapshot(): Promise<BoardSceneSnapshot> {
  return {
    version: 1,
    elements: await documentToSceneElements(createDemoDocument()),
    appState: {
      viewBackgroundColor: DEFAULT_SCENE_BACKGROUND,
    },
  };
}

export async function migrateLegacyDocumentToSceneSnapshot(rawDocument: string): Promise<BoardSceneSnapshot> {
  try {
    const parsed = JSON.parse(rawDocument) as DiagramDocument;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return {
        version: 1,
        elements: await documentToSceneElements(removeDanglingEdges(parsed)),
        appState: {
          viewBackgroundColor: DEFAULT_SCENE_BACKGROUND,
        },
      };
    }
  } catch {
    // fall through to demo snapshot
  }
  return await createDemoSceneSnapshot();
}

function readElementId(element: unknown): string | undefined {
  return isRecord(element) && typeof element.id === "string" && element.id.length > 0 ? element.id : undefined;
}

function readContainerId(element: unknown): string | undefined {
  return isRecord(element) && typeof element.containerId === "string" && element.containerId.length > 0 ? element.containerId : undefined;
}

function readBridgeData(element: unknown): ExcalidrawCustomData | undefined {
  if (!isRecord(element) || !isRecord(element.customData)) {
    return undefined;
  }
  const customData = element.customData as Record<string, unknown>;
  if (customData.bridgeType === "node" && typeof customData.bridgeId === "string" && typeof customData.nodeKind === "string") {
    return {
      bridgeType: "node",
      bridgeId: customData.bridgeId,
      nodeKind: customData.nodeKind as DiagramNode["kind"],
      ...(typeof customData.description === "string" ? { description: customData.description } : {}),
    };
  }
  if (
    customData.bridgeType === "edge" &&
    typeof customData.bridgeId === "string" &&
    typeof customData.sourceNodeId === "string" &&
    typeof customData.targetNodeId === "string"
  ) {
    return {
      bridgeType: "edge",
      bridgeId: customData.bridgeId,
      sourceNodeId: customData.sourceNodeId,
      targetNodeId: customData.targetNodeId,
      ...(typeof customData.label === "string" ? { label: customData.label } : {}),
      ...(typeof customData.protocol === "string" ? { protocol: customData.protocol } : {}),
    };
  }
  return undefined;
}

function collectBridgeContainerIds(elements: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    if (isDeleted(element)) {
      continue;
    }
    const bridgeData = readBridgeData(element);
    const id = readElementId(element);
    if (bridgeData && id) {
      ids.add(id);
    }
  }
  return ids;
}

function isBridgeManagedElement(element: unknown, bridgeContainerIds: ReadonlySet<string>): boolean {
  if (isDeleted(element)) {
    return false;
  }
  if (readBridgeData(element)) {
    return true;
  }
  const containerId = readContainerId(element);
  return typeof containerId === "string" && bridgeContainerIds.has(containerId);
}

function splitSceneElements(elements: readonly unknown[]): { bridgeElements: unknown[]; externalElements: unknown[] } {
  const bridgeContainerIds = collectBridgeContainerIds(elements);
  const bridgeElements: unknown[] = [];
  const externalElements: unknown[] = [];
  for (const element of elements) {
    if (isDeleted(element)) {
      continue;
    }
    if (isBridgeManagedElement(element, bridgeContainerIds)) {
      bridgeElements.push(cloneElement(element));
      continue;
    }
    externalElements.push(cloneElement(element));
  }
  return { bridgeElements, externalElements };
}

function getTextForContainer(elements: readonly unknown[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const element of elements) {
    if (!isRecord(element) || isDeleted(element)) {
      continue;
    }
    if (element.type !== "text" || typeof element.text !== "string" || !element.text.trim()) {
      continue;
    }
    const containerId = readContainerId(element);
    if (!containerId) {
      continue;
    }
    labels.set(containerId, normalizeLabelText(element.text));
  }
  return labels;
}

function getElementsByContainerId(elements: readonly unknown[]): Map<string, RawElement[]> {
  const grouped = new Map<string, RawElement[]>();
  for (const element of elements) {
    if (!isRecord(element) || isDeleted(element)) {
      continue;
    }
    const containerId = readContainerId(element);
    if (!containerId) {
      continue;
    }
    const current = grouped.get(containerId) ?? [];
    current.push(element);
    grouped.set(containerId, current);
  }
  return grouped;
}

function readOptionalStringField(element: RawElement, field: string): string | undefined {
  return typeof element[field] === "string" ? element[field] : undefined;
}

function readOptionalNumberField(element: RawElement, field: string): number | undefined {
  return typeof element[field] === "number" && Number.isFinite(element[field] as number) ? (element[field] as number) : undefined;
}

function deriveNodeStyle(shape: RawElement, children: readonly RawElement[]): DiagramNodeStyle | undefined {
  const labelElement = children.find((element) => element.type === "text");
  const style: DiagramNodeStyle = {};
  const strokeColor = readOptionalStringField(shape, "strokeColor");
  const backgroundColor = readOptionalStringField(shape, "backgroundColor");
  const textColor = labelElement ? readOptionalStringField(labelElement, "strokeColor") : undefined;
  const fillStyle = readOptionalStringField(shape, "fillStyle");
  const roughness = readOptionalNumberField(shape, "roughness");
  const opacity = readOptionalNumberField(shape, "opacity");
  if (strokeColor !== undefined) {
    style.strokeColor = strokeColor;
  }
  if (backgroundColor !== undefined) {
    style.backgroundColor = backgroundColor;
  }
  if (textColor !== undefined) {
    style.textColor = textColor;
  }
  if (fillStyle !== undefined) {
    style.fillStyle = fillStyle === "solid" || fillStyle === "hachure" || fillStyle === "cross-hatch" ? fillStyle : "solid";
  }
  if (roughness !== undefined) {
    style.roughness = roughness;
  }
  if (opacity !== undefined) {
    style.opacity = opacity;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function deriveEdgeStyle(shape: RawElement, children: readonly RawElement[]): DiagramEdgeStyle | undefined {
  const labelElement = children.find((element) => element.type === "text");
  const style: DiagramEdgeStyle = {};
  const strokeColor = readOptionalStringField(shape, "strokeColor");
  const textColor = labelElement ? readOptionalStringField(labelElement, "strokeColor") : undefined;
  const strokeStyle = readOptionalStringField(shape, "strokeStyle");
  const strokeWidth = readOptionalNumberField(shape, "strokeWidth");
  const opacity = readOptionalNumberField(shape, "opacity");
  if (strokeColor !== undefined) {
    style.strokeColor = strokeColor;
  }
  if (textColor !== undefined) {
    style.textColor = textColor;
  }
  if (strokeStyle !== undefined) {
    style.strokeStyle = strokeStyle === "solid" || strokeStyle === "dashed" || strokeStyle === "dotted" ? strokeStyle : "solid";
  }
  if (strokeWidth !== undefined) {
    style.strokeWidth = strokeWidth;
  }
  if (opacity !== undefined) {
    style.opacity = opacity;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

export function deriveDocumentFromScene(snapshot: BoardSceneSnapshot): DiagramDocument {
  const labelsByContainerId = getTextForContainer(snapshot.elements);
  const childrenByContainerId = getElementsByContainerId(snapshot.elements);
  const nodes: DiagramNode[] = [];
  for (const element of snapshot.elements) {
    if (!isRecord(element) || isDeleted(element) || element.type !== "rectangle") {
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (!bridgeData || bridgeData.bridgeType !== "node") {
      continue;
    }
    if (
      typeof element.x !== "number" ||
      typeof element.y !== "number" ||
      typeof element.width !== "number" ||
      typeof element.height !== "number"
    ) {
      continue;
    }
    const label = labelsByContainerId.get(readElementId(element) ?? "") ?? "Untitled";
    const style = deriveNodeStyle(element, childrenByContainerId.get(readElementId(element) ?? "") ?? []);
    nodes.push({
      id: bridgeData.bridgeId,
      label,
      kind: bridgeData.nodeKind,
      ...(bridgeData.description !== undefined ? { description: bridgeData.description } : {}),
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      ...(style ? { style } : {}),
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: DiagramEdge[] = [];
  for (const element of snapshot.elements) {
    if (!isRecord(element) || isDeleted(element) || element.type !== "arrow") {
      continue;
    }
    const bridgeData = readBridgeData(element);
    if (!bridgeData || bridgeData.bridgeType !== "edge") {
      continue;
    }
    if (!nodeIds.has(bridgeData.sourceNodeId) || !nodeIds.has(bridgeData.targetNodeId)) {
      continue;
    }
    const style = deriveEdgeStyle(element, childrenByContainerId.get(readElementId(element) ?? "") ?? []);
    edges.push({
      id: bridgeData.bridgeId,
      sourceNodeId: bridgeData.sourceNodeId,
      targetNodeId: bridgeData.targetNodeId,
      ...(bridgeData.label !== undefined ? { label: bridgeData.label } : {}),
      ...(bridgeData.protocol !== undefined ? { protocol: bridgeData.protocol } : {}),
      ...(style ? { style } : {}),
    });
  }

  return removeDanglingEdges({
    version: 1,
    nodes,
    edges,
  });
}

function patchTextChildren(elements: unknown[], containerId: string, patch: Record<string, unknown>): void {
  for (const element of elements) {
    if (!isRecord(element) || readContainerId(element) !== containerId || element.type !== "text") {
      continue;
    }
    Object.assign(element, patch);
  }
}

function patchBridgeElements(
  snapshot: BoardSceneSnapshot,
  mutate: (elements: unknown[]) => void,
  appStatePatch?: Partial<BoardSceneAppState>,
): BoardSceneSnapshot {
  const nextElements = normalizeElements(snapshot.elements);
  mutate(nextElements);
  return {
    version: 1,
    elements: nextElements,
    appState: {
      ...snapshot.appState,
      ...appStatePatch,
    },
  };
}

export function deriveSummaryFromScene(snapshot: BoardSceneSnapshot): DiagramSummary {
  return summarizeDocument(deriveDocumentFromScene(snapshot));
}

function selectionFromScene(elements: readonly unknown[], selectedElementIds: ReadonlySet<string>): DiagramSelection {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const bridgeDataByElementId = new Map<string, ExcalidrawCustomData>();
  for (const element of elements) {
    const id = readElementId(element);
    const bridgeData = readBridgeData(element);
    if (id && bridgeData) {
      bridgeDataByElementId.set(id, bridgeData);
    }
  }

  for (const element of elements) {
    const id = readElementId(element);
    if (!id || !selectedElementIds.has(id)) {
      continue;
    }
    const direct = bridgeDataByElementId.get(id);
    const viaContainer = readContainerId(element) ? bridgeDataByElementId.get(readContainerId(element) as string) : undefined;
    const bridgeData = direct ?? viaContainer;
    if (!bridgeData) {
      continue;
    }
    if (bridgeData.bridgeType === "node") {
      nodeIds.add(bridgeData.bridgeId);
    } else {
      edgeIds.add(bridgeData.bridgeId);
    }
  }

  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
  };
}

export function deriveSelection(snapshot: BoardSceneSnapshot, selectedElementIds: ReadonlySet<string>): DiagramSelection {
  return selectionFromScene(snapshot.elements, selectedElementIds);
}

function expandSelectedElementIds(elements: readonly unknown[], selectedElementIds: ReadonlySet<string>): Set<string> {
  const expanded = new Set(selectedElementIds);
  for (const element of elements) {
    const containerId = readContainerId(element);
    const id = readElementId(element);
    if (!containerId || !id) {
      continue;
    }
    if (selectedElementIds.has(containerId)) {
      expanded.add(id);
    }
  }
  return expanded;
}

async function replaceBridgeElements(snapshot: BoardSceneSnapshot, document: DiagramDocument, externalElements?: unknown[]): Promise<BoardSceneSnapshot> {
  const nextExternalElements = externalElements ?? splitSceneElements(snapshot.elements).externalElements;
  const bridgeElements = await documentToSceneElements(document);
  return {
    version: 1,
    elements: [...nextExternalElements, ...bridgeElements],
    appState: snapshot.appState,
  };
}

export async function upsertNodesInScene(snapshot: BoardSceneSnapshot, inputs: UpsertNodeInput[]): Promise<BoardSceneSnapshot> {
  const nextDocument = upsertNodes(deriveDocumentFromScene(snapshot), inputs);
  return await replaceBridgeElements(snapshot, nextDocument);
}

export async function upsertEdgesInScene(snapshot: BoardSceneSnapshot, inputs: UpsertEdgeInput[]): Promise<BoardSceneSnapshot> {
  const nextDocument = upsertEdges(deriveDocumentFromScene(snapshot), inputs);
  return await replaceBridgeElements(snapshot, nextDocument);
}

export async function removeNodesFromScene(snapshot: BoardSceneSnapshot, nodeIds: readonly string[]): Promise<BoardSceneSnapshot> {
  const nextDocument = removeNodesById(deriveDocumentFromScene(snapshot), nodeIds);
  return await replaceBridgeElements(snapshot, nextDocument);
}

export async function removeEdgesFromScene(snapshot: BoardSceneSnapshot, edgeIds: readonly string[]): Promise<BoardSceneSnapshot> {
  const nextDocument = removeEdgesById(deriveDocumentFromScene(snapshot), edgeIds);
  return await replaceBridgeElements(snapshot, nextDocument);
}

export function styleNodesInScene(snapshot: BoardSceneSnapshot, patch: NodeStylePatch): BoardSceneSnapshot {
  const nodeIds = new Set(patch.nodeIds);
  return patchBridgeElements(snapshot, (elements) => {
    for (const element of elements) {
      if (!isRecord(element) || isDeleted(element) || element.type !== "rectangle") {
        continue;
      }
      const bridgeData = readBridgeData(element);
      if (!bridgeData || bridgeData.bridgeType !== "node" || !nodeIds.has(bridgeData.bridgeId)) {
        continue;
      }
      if (patch.strokeColor !== undefined) {
        element.strokeColor = patch.strokeColor;
      }
      if (patch.backgroundColor !== undefined) {
        element.backgroundColor = patch.backgroundColor;
      }
      if (patch.fillStyle !== undefined) {
        element.fillStyle = patch.fillStyle;
      }
      if (patch.roughness !== undefined) {
        element.roughness = patch.roughness;
      }
      if (patch.opacity !== undefined) {
        element.opacity = patch.opacity;
      }
      const elementId = readElementId(element);
      if (elementId && patch.textColor !== undefined) {
        patchTextChildren(elements, elementId, { strokeColor: patch.textColor });
      }
    }
  });
}

export function styleEdgesInScene(snapshot: BoardSceneSnapshot, patch: EdgeStylePatch): BoardSceneSnapshot {
  const edgeIds = new Set(patch.edgeIds);
  return patchBridgeElements(snapshot, (elements) => {
    for (const element of elements) {
      if (!isRecord(element) || isDeleted(element) || element.type !== "arrow") {
        continue;
      }
      const bridgeData = readBridgeData(element);
      if (!bridgeData || bridgeData.bridgeType !== "edge" || !edgeIds.has(bridgeData.bridgeId)) {
        continue;
      }
      if (patch.strokeColor !== undefined) {
        element.strokeColor = patch.strokeColor;
      }
      if (patch.strokeStyle !== undefined) {
        element.strokeStyle = patch.strokeStyle;
      }
      if (patch.strokeWidth !== undefined) {
        element.strokeWidth = patch.strokeWidth;
      }
      if (patch.opacity !== undefined) {
        element.opacity = patch.opacity;
      }
      const elementId = readElementId(element);
      if (elementId && patch.textColor !== undefined) {
        patchTextChildren(elements, elementId, { strokeColor: patch.textColor });
      }
    }
  });
}

export function resizeNodesInScene(snapshot: BoardSceneSnapshot, input: ResizeNodeInput): BoardSceneSnapshot {
  const nodeIds = new Set(input.nodeIds);
  return patchBridgeElements(snapshot, (elements) => {
    for (const element of elements) {
      if (!isRecord(element) || isDeleted(element) || element.type !== "rectangle") {
        continue;
      }
      const bridgeData = readBridgeData(element);
      if (!bridgeData || bridgeData.bridgeType !== "node" || !nodeIds.has(bridgeData.bridgeId)) {
        continue;
      }
      if (input.width !== undefined) {
        element.width = input.width;
      }
      if (input.height !== undefined) {
        element.height = input.height;
      }
    }
  });
}

export function styleCanvasInScene(snapshot: BoardSceneSnapshot, patch: CanvasStylePatch): BoardSceneSnapshot {
  return patchBridgeElements(snapshot, () => {}, {
    ...(patch.backgroundColor !== undefined ? { viewBackgroundColor: patch.backgroundColor } : {}),
  });
}

export async function applyLayoutToScene(
  snapshot: BoardSceneSnapshot,
  mode: LayoutMode,
  scope: LayoutScope,
  selectedElementIds: ReadonlySet<string>,
): Promise<BoardSceneSnapshot> {
  const document = deriveDocumentFromScene(snapshot);
  const selection = selectionFromScene(snapshot.elements, selectedElementIds);
  const nextDocument = applyLayout(document, mode, scope, selection);
  return await replaceBridgeElements(snapshot, nextDocument);
}

export async function removeSelectionFromScene(snapshot: BoardSceneSnapshot, selectedElementIds: ReadonlySet<string>): Promise<BoardSceneSnapshot> {
  const expandedSelection = expandSelectedElementIds(snapshot.elements, selectedElementIds);
  const externalElements = splitSceneElements(snapshot.elements).externalElements.filter((element) => {
    const id = readElementId(element);
    return !id || !expandedSelection.has(id);
  });
  const nextDocument = removeBySelection(deriveDocumentFromScene(snapshot), selectionFromScene(snapshot.elements, selectedElementIds));
  return await replaceBridgeElements(snapshot, nextDocument, externalElements);
}

export function selectedElementIdsFromAppState(appState: unknown): Set<string> {
  if (!isRecord(appState) || !isRecord(appState.selectedElementIds)) {
    return new Set<string>();
  }
  return new Set(
    Object.entries(appState.selectedElementIds as Record<string, unknown>)
      .filter(([, selected]) => selected === true)
      .map(([elementId]) => elementId),
  );
}
