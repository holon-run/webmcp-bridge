/**
 * This module derives bridge-managed graph data from Excalidraw scene snapshots and applies scene-first mutations.
 * It depends on the pure model helpers and is used by both the React UI and WebMCP tools.
 */

import {
  applyLayout,
  createDemoDocument,
  createEmptyDocument,
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

type RawAppState = {
  viewBackgroundColor?: unknown;
  scrollX?: unknown;
  scrollY?: unknown;
  zoom?: unknown;
  selectedElementIds?: Record<string, boolean>;
};

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
    const { label, ...shape } = skeleton;
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

function normalizeLabelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

export function createSceneSnapshot(elements: readonly unknown[], appState?: unknown): BoardSceneSnapshot {
  return {
    version: 1,
    elements: normalizeElements(elements),
    appState: sanitizeAppState(appState),
  };
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

  return convertToExcalidrawElements(skeletons);
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
