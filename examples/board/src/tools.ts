/**
 * This module defines and registers the WebMCP tools exposed by the native board example.
 * It depends on the authoritative scene state and scene-derived helpers so browser and local-mcp clients share one tool contract.
 */

import type { BoardSceneState } from "./scene-state.js";
import {
  applyLayoutToScene,
  deriveDocumentFromScene,
  deriveSummaryFromScene,
  removeEdgesFromScene,
  removeNodesFromScene,
  upsertEdgesInScene,
  upsertNodesInScene,
} from "./excalidraw.js";
import type { JsonValue, NodeKind, UpsertEdgeInput, UpsertNodeInput, WebMcpModelContext, WebMcpToolDefinition } from "./types.js";

type ExportApi = {
  getSceneElements?: () => unknown[];
  exportToBlob?: (opts: unknown) => Promise<Blob>;
};

const TOOL_NAMES = [
  "nodes.list",
  "nodes.upsert",
  "nodes.remove",
  "edges.list",
  "edges.upsert",
  "edges.remove",
  "layout.apply",
  "diagram.reset",
  "diagram.export",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

function createToolRegistry(sceneState: BoardSceneState, getExportApi: () => ExportApi | undefined): Record<ToolName, WebMcpToolDefinition> {
  return {
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
        if (!api?.exportToBlob) {
          throw new Error("png export requires an active Excalidraw API");
        }
        const blob = await api.exportToBlob({
          mimeType: "image/png",
          elements: api.getSceneElements?.() ?? scene.elements,
          appState: {
            exportBackground: true,
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
