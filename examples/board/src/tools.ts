/**
 * This module defines and registers the WebMCP tools exposed by the native board example.
 * It depends on the authoritative scene state and scene-derived helpers so browser and local-mcp clients share one tool contract.
 */

import type { BoardSceneState } from "./scene-state.js";
import {
  applyLayoutToScene,
  deriveDocumentFromScene,
  deriveSelection,
  deriveSummaryFromScene,
  removeEdgesFromScene,
  removeNodesFromScene,
  removeSelectionFromScene,
  resizeNodesInScene,
  styleCanvasInScene,
  styleEdgesInScene,
  styleNodesInScene,
  upsertEdgesInScene,
  upsertNodesInScene,
} from "./excalidraw.js";
import type {
  EdgeStylePatch,
  FitViewInput,
  JsonValue,
  NodeKind,
  NodeStylePatch,
  ResizeNodeInput,
  UpsertEdgeInput,
  UpsertNodeInput,
  WebMcpModelContext,
  WebMcpToolDefinition,
} from "./types.js";

type ExportApi = {
  getSceneElements?: () => unknown[];
  refresh?: () => void;
  scrollToContent?: (
    target?: unknown[] | string | unknown,
    opts?: {
      fitToContent?: boolean;
      fitToViewport?: boolean;
      viewportZoomFactor?: number;
      animate?: boolean;
      duration?: number;
    },
  ) => void;
  exportToBlob?: (opts: unknown) => Promise<Blob>;
};

const TOOL_NAMES = [
  "diagram.get",
  "diagram.loadDemo",
  "nodes.list",
  "nodes.upsert",
  "nodes.style",
  "nodes.resize",
  "nodes.remove",
  "edges.list",
  "edges.upsert",
  "edges.style",
  "edges.remove",
  "selection.get",
  "selection.remove",
  "layout.apply",
  "canvas.style",
  "view.fit",
  "diagram.reset",
  "diagram.export",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

async function loadExportToBlob(): Promise<((opts: unknown) => Promise<Blob>) | undefined> {
  try {
    const excalidrawLib = await import("@excalidraw/excalidraw");
    const exporter = (excalidrawLib as unknown as { exportToBlob?: (opts: unknown) => Promise<Blob> }).exportToBlob;
    return typeof exporter === "function" ? exporter : undefined;
  } catch {
    return undefined;
  }
}

function createToolRegistry(sceneState: BoardSceneState, getExportApi: () => ExportApi | undefined): Record<ToolName, WebMcpToolDefinition> {
  return {
    "diagram.get": {
      name: "diagram.get",
      description: "Get the current structured diagram snapshot derived from the authoritative Excalidraw scene.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        const scene = sceneState.getSnapshot();
        return {
          document: deriveDocumentFromScene(scene),
          summary: deriveSummaryFromScene(scene),
        };
      },
    },
    "diagram.loadDemo": {
      name: "diagram.loadDemo",
      description: "Replace the current diagram with the built-in bridge architecture demo scene.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        await sceneState.resetToDemo();
        const nextScene = sceneState.getSnapshot();
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "nodes.list": {
      name: "nodes.list",
      description: "List all structured diagram nodes with positions and kinds.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        const scene = sceneState.getSnapshot();
        return {
          items: deriveDocumentFromScene(scene).nodes,
          summary: deriveSummaryFromScene(scene),
        };
      },
    },
    "nodes.upsert": {
      name: "nodes.upsert",
      description: "Create or update one or more architecture nodes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["nodes"],
        properties: {
          nodes: {
            type: "array",
            description: "Nodes to create or update.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "kind"],
              properties: {
                id: { type: "string", description: "Stable node id for updates." },
                label: { type: "string", description: "Visible node label." },
                kind: { type: "string", description: "Node category." },
                description: { type: "string", description: "Optional node details." },
                x: { type: "number", description: "Optional x coordinate." },
                y: { type: "number", description: "Optional y coordinate." },
              },
            },
          },
        },
      },
      execute: async (input) => {
        const nodes = readArrayField(input, "nodes");
        const nextScene = await upsertNodesInScene(
          sceneState.getSnapshot(),
          nodes.map((node) => toUpsertNodeInput(node)),
        );
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "nodes.style": {
      name: "nodes.style",
      description: "Patch visual styles for one or more nodes without changing their structure.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["nodeIds"],
        properties: {
          nodeIds: {
            type: "array",
            description: "Node ids to style.",
            items: { type: "string", description: "Stable node id to style." },
          },
          strokeColor: { type: "string", description: "Optional node stroke color." },
          backgroundColor: { type: "string", description: "Optional node fill color." },
          textColor: { type: "string", description: "Optional node label color." },
          fillStyle: { type: "string", description: "Optional node fill style." },
          roughness: { type: "number", description: "Optional Excalidraw roughness." },
          opacity: { type: "number", description: "Optional node opacity from 0 to 100." },
        },
      },
      execute: async (input) => {
        const nextScene = styleNodesInScene(sceneState.getSnapshot(), readNodeStylePatch(input));
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "nodes.resize": {
      name: "nodes.resize",
      description: "Resize one or more nodes without changing their positions.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["nodeIds"],
        properties: {
          nodeIds: {
            type: "array",
            description: "Node ids to resize.",
            items: { type: "string", description: "Stable node id to resize." },
          },
          width: { type: "number", description: "Optional new node width." },
          height: { type: "number", description: "Optional new node height." },
        },
      },
      execute: async (input) => {
        const nextScene = resizeNodesInScene(sceneState.getSnapshot(), readResizeNodeInput(input));
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "nodes.remove": {
      name: "nodes.remove",
      description: "Remove one or more nodes by id and delete their dangling edges.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["nodeIds"],
        properties: {
          nodeIds: {
            type: "array",
            description: "Node ids to delete.",
            items: {
              type: "string",
              description: "Stable node id to remove.",
            },
          },
        },
      },
      execute: async (input) => {
        const nodeIds = readStringArrayField(input, "nodeIds");
        const nextScene = await removeNodesFromScene(sceneState.getSnapshot(), nodeIds);
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "edges.list": {
      name: "edges.list",
      description: "List all structured diagram edges.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        const scene = sceneState.getSnapshot();
        return {
          items: deriveDocumentFromScene(scene).edges,
          summary: deriveSummaryFromScene(scene),
        };
      },
    },
    "edges.upsert": {
      name: "edges.upsert",
      description: "Create or update one or more architecture edges.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["edges"],
        properties: {
          edges: {
            type: "array",
            description: "Edges to create or update.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sourceNodeId", "targetNodeId"],
              properties: {
                id: { type: "string", description: "Stable edge id for updates." },
                sourceNodeId: { type: "string", description: "Source node id." },
                targetNodeId: { type: "string", description: "Target node id." },
                label: { type: "string", description: "Optional visible edge label." },
                protocol: { type: "string", description: "Optional protocol hint." },
              },
            },
          },
        },
      },
      execute: async (input) => {
        const edges = readArrayField(input, "edges");
        const nextScene = await upsertEdgesInScene(
          sceneState.getSnapshot(),
          edges.map((edge) => toUpsertEdgeInput(edge)),
        );
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "edges.style": {
      name: "edges.style",
      description: "Patch visual styles for one or more edges without changing their endpoints.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["edgeIds"],
        properties: {
          edgeIds: {
            type: "array",
            description: "Edge ids to style.",
            items: { type: "string", description: "Stable edge id to style." },
          },
          strokeColor: { type: "string", description: "Optional edge stroke color." },
          textColor: { type: "string", description: "Optional edge label color." },
          strokeStyle: { type: "string", description: "Optional line style: solid, dashed, or dotted." },
          strokeWidth: { type: "number", description: "Optional edge stroke width." },
          opacity: { type: "number", description: "Optional edge opacity from 0 to 100." },
        },
      },
      execute: async (input) => {
        const nextScene = styleEdgesInScene(sceneState.getSnapshot(), readEdgeStylePatch(input));
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "edges.remove": {
      name: "edges.remove",
      description: "Remove one or more edges by id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["edgeIds"],
        properties: {
          edgeIds: {
            type: "array",
            description: "Edge ids to delete.",
            items: {
              type: "string",
              description: "Stable edge id to remove.",
            },
          },
        },
      },
      execute: async (input) => {
        const edgeIds = readStringArrayField(input, "edgeIds");
        const nextScene = await removeEdgesFromScene(sceneState.getSnapshot(), edgeIds);
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "selection.get": {
      name: "selection.get",
      description: "Get the current user selection mapped to structured node and edge ids.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        const scene = sceneState.getSnapshot();
        return {
          selection: deriveSelection(scene, sceneState.getSelectedElementIds()),
          summary: deriveSummaryFromScene(scene),
        };
      },
    },
    "selection.remove": {
      name: "selection.remove",
      description: "Delete the currently selected nodes, edges, and attached external elements.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        const nextScene = await removeSelectionFromScene(sceneState.getSnapshot(), sceneState.getSelectedElementIds());
        sceneState.setSelectedElementIds([]);
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "layout.apply": {
      name: "layout.apply",
      description: "Apply a deterministic layout to the whole diagram or current selection.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: {
          mode: { type: "string", description: "Layout mode: layered or grid." },
          scope: { type: "string", description: "Layout scope: all or selection." },
        },
      },
      execute: async (input) => {
        const nextScene = await applyLayoutToScene(
          sceneState.getSnapshot(),
          readLayoutMode(input),
          readLayoutScope(input),
          sceneState.getSelectedElementIds(),
        );
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "canvas.style": {
      name: "canvas.style",
      description: "Update persisted canvas-level presentation settings such as background color.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          backgroundColor: { type: "string", description: "Optional Excalidraw view background color." },
        },
      },
      execute: async (input) => {
        const backgroundColor = readOptionalString(input, "backgroundColor");
        const nextScene = styleCanvasInScene(sceneState.getSnapshot(), {
          ...(backgroundColor !== undefined ? { backgroundColor } : {}),
        });
        sceneState.setSnapshot(nextScene);
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "view.fit": {
      name: "view.fit",
      description: "Fit the current viewport to the visible diagram without changing persisted document state.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          animate: { type: "boolean", description: "Whether to animate the viewport change." },
          viewportZoomFactor: { type: "number", description: "Optional zoom factor applied during fit." },
        },
      },
      execute: async (input) => {
        const api = getExportApi();
        if (!api?.scrollToContent) {
          throw new Error("view.fit requires an active Excalidraw API");
        }
        const fitInput = readFitViewInput(input);
        const scene = sceneState.getSnapshot();
        api.scrollToContent(api.getSceneElements?.() ?? scene.elements, {
          fitToViewport: true,
          viewportZoomFactor: fitInput.viewportZoomFactor ?? 0.9,
          animate: fitInput.animate ?? false,
        });
        api.refresh?.();
        return {
          ok: true,
          summary: deriveSummaryFromScene(scene),
        };
      },
    },
    "diagram.reset": {
      name: "diagram.reset",
      description: "Clear the diagram and selection state.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        sceneState.clear();
        const nextScene = sceneState.getSnapshot();
        return {
          document: deriveDocumentFromScene(nextScene),
          summary: deriveSummaryFromScene(nextScene),
        };
      },
    },
    "diagram.export": {
      name: "diagram.export",
      description: "Export the current diagram as JSON or PNG.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: {
          format: { type: "string", description: "Export format: json or png." },
        },
      },
      execute: async (input) => {
        const format = readExportFormat(input);
        const scene = sceneState.getSnapshot();
        if (format === "json") {
          return {
            format,
            data: deriveDocumentFromScene(scene),
          };
        }
        const api = getExportApi();
        const exportToBlob = api?.exportToBlob ?? (await loadExportToBlob());
        if (!exportToBlob) {
          throw new Error("png export requires an active Excalidraw API");
        }
        const blob = await exportToBlob({
          mimeType: "image/png",
          elements: api?.getSceneElements?.() ?? scene.elements,
          appState: {
            exportBackground: true,
            viewBackgroundColor: scene.appState.viewBackgroundColor,
          },
          files: {},
        });
        return {
          format,
          data: await blobToDataUrl(blob),
        };
      },
    },
  };
}

function readRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("expected object input");
  }
  return value as Record<string, JsonValue>;
}

function readArrayField(value: JsonValue, field: string): JsonValue[] {
  const record = readRecord(value);
  const current = record[field];
  if (!Array.isArray(current)) {
    throw new Error(`${field} must be an array`);
  }
  return current;
}

function readStringArrayField(value: JsonValue, field: string): string[] {
  return readArrayField(value, field).map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field}[${String(index)}] must be a non-empty string`);
    }
    return item;
  });
}

function readRequiredString(value: JsonValue, field: string): string {
  const record = readRecord(value);
  const current = record[field];
  if (typeof current !== "string" || !current.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return current;
}

function readOptionalString(value: JsonValue, field: string): string | undefined {
  const record = readRecord(value);
  const current = record[field];
  if (current === undefined || current === null) {
    return undefined;
  }
  if (typeof current !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return current;
}

function readOptionalNumber(value: JsonValue, field: string): number | undefined {
  const record = readRecord(value);
  const current = record[field];
  if (current === undefined || current === null) {
    return undefined;
  }
  if (typeof current !== "number" || Number.isNaN(current)) {
    throw new Error(`${field} must be a number`);
  }
  return current;
}

function readOptionalBoolean(value: JsonValue, field: string): boolean | undefined {
  const record = readRecord(value);
  const current = record[field];
  if (current === undefined || current === null) {
    return undefined;
  }
  if (typeof current !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return current;
}

function readNodeKind(value: JsonValue, field: string): NodeKind {
  const current = readRequiredString(value, field);
  if (
    current !== "actor" &&
    current !== "service" &&
    current !== "database" &&
    current !== "queue" &&
    current !== "cache" &&
    current !== "external"
  ) {
    throw new Error(`${field} must be one of actor, service, database, queue, cache, external`);
  }
  return current;
}

function readLayoutMode(value: JsonValue): "layered" | "grid" {
  const current = readRequiredString(value, "mode");
  if (current !== "layered" && current !== "grid") {
    throw new Error("mode must be layered or grid");
  }
  return current;
}

function readLayoutScope(value: JsonValue): "all" | "selection" {
  const current = readOptionalString(value, "scope");
  if (current === undefined) {
    return "all";
  }
  if (current !== "all" && current !== "selection") {
    throw new Error("scope must be all or selection");
  }
  return current;
}

function readExportFormat(value: JsonValue): "json" | "png" {
  const current = readRequiredString(value, "format");
  if (current !== "json" && current !== "png") {
    throw new Error("format must be json or png");
  }
  return current;
}

function readFillStyle(value: JsonValue, field: string): "solid" | "hachure" | "cross-hatch" | undefined {
  const current = readOptionalString(value, field);
  if (current === undefined) {
    return undefined;
  }
  if (current !== "solid" && current !== "hachure" && current !== "cross-hatch") {
    throw new Error(`${field} must be solid, hachure, or cross-hatch`);
  }
  return current;
}

function readStrokeStyle(value: JsonValue, field: string): "solid" | "dashed" | "dotted" | undefined {
  const current = readOptionalString(value, field);
  if (current === undefined) {
    return undefined;
  }
  if (current !== "solid" && current !== "dashed" && current !== "dotted") {
    throw new Error(`${field} must be solid, dashed, or dotted`);
  }
  return current;
}

function toUpsertNodeInput(value: JsonValue): UpsertNodeInput {
  const input: UpsertNodeInput = {
    label: readRequiredString(value, "label"),
    kind: readNodeKind(value, "kind"),
  };
  const id = readOptionalString(value, "id");
  const description = readOptionalString(value, "description");
  const x = readOptionalNumber(value, "x");
  const y = readOptionalNumber(value, "y");
  if (id !== undefined) {
    input.id = id;
  }
  if (description !== undefined) {
    input.description = description;
  }
  if (x !== undefined) {
    input.x = x;
  }
  if (y !== undefined) {
    input.y = y;
  }
  return input;
}

function toUpsertEdgeInput(value: JsonValue): UpsertEdgeInput {
  const input: UpsertEdgeInput = {
    sourceNodeId: readRequiredString(value, "sourceNodeId"),
    targetNodeId: readRequiredString(value, "targetNodeId"),
  };
  const id = readOptionalString(value, "id");
  const label = readOptionalString(value, "label");
  const protocol = readOptionalString(value, "protocol");
  if (id !== undefined) {
    input.id = id;
  }
  if (label !== undefined) {
    input.label = label;
  }
  if (protocol !== undefined) {
    input.protocol = protocol;
  }
  return input;
}

function readNodeStylePatch(value: JsonValue): NodeStylePatch {
  const strokeColor = readOptionalString(value, "strokeColor");
  const backgroundColor = readOptionalString(value, "backgroundColor");
  const textColor = readOptionalString(value, "textColor");
  const fillStyle = readFillStyle(value, "fillStyle");
  const roughness = readOptionalNumber(value, "roughness");
  const opacity = readOptionalNumber(value, "opacity");
  return {
    nodeIds: readStringArrayField(value, "nodeIds"),
    ...(strokeColor !== undefined ? { strokeColor } : {}),
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
    ...(textColor !== undefined ? { textColor } : {}),
    ...(fillStyle !== undefined ? { fillStyle } : {}),
    ...(roughness !== undefined ? { roughness } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
  };
}

function readEdgeStylePatch(value: JsonValue): EdgeStylePatch {
  const strokeColor = readOptionalString(value, "strokeColor");
  const textColor = readOptionalString(value, "textColor");
  const strokeStyle = readStrokeStyle(value, "strokeStyle");
  const strokeWidth = readOptionalNumber(value, "strokeWidth");
  const opacity = readOptionalNumber(value, "opacity");
  return {
    edgeIds: readStringArrayField(value, "edgeIds"),
    ...(strokeColor !== undefined ? { strokeColor } : {}),
    ...(textColor !== undefined ? { textColor } : {}),
    ...(strokeStyle !== undefined ? { strokeStyle } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
  };
}

function readResizeNodeInput(value: JsonValue): ResizeNodeInput {
  const width = readOptionalNumber(value, "width");
  const height = readOptionalNumber(value, "height");
  if (width === undefined && height === undefined) {
    throw new Error("at least one of width or height must be provided");
  }
  return {
    nodeIds: readStringArrayField(value, "nodeIds"),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function readFitViewInput(value: JsonValue): FitViewInput {
  const animate = readOptionalBoolean(value, "animate");
  const viewportZoomFactor = readOptionalNumber(value, "viewportZoomFactor");
  return {
    ...(animate !== undefined ? { animate } : {}),
    ...(viewportZoomFactor !== undefined ? { viewportZoomFactor } : {}),
  };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("failed to read export blob"));
    };
    reader.readAsDataURL(blob);
  });
}

export async function registerBoardTools(
  modelContext: WebMcpModelContext,
  sceneState: BoardSceneState,
  getExportApi: () => ExportApi | undefined,
): Promise<void> {
  const existing = await modelContext.listTools();
  for (const name of TOOL_NAMES) {
    if (existing.some((tool) => tool.name === name)) {
      await modelContext.unregisterTool(name);
    }
  }

  const tools = createToolRegistry(sceneState, getExportApi);
  for (const name of TOOL_NAMES) {
    await modelContext.registerTool(tools[name]);
  }
}
