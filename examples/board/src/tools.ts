/**
 * This module defines and registers the WebMCP tools exposed by the native board example.
 * It depends on the diagram store and local modelContext shim so browser and local-mcp clients share one tool contract.
 */

import type { DiagramStore } from "./state.js";
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

function createToolRegistry(store: DiagramStore, getExportApi: () => ExportApi | undefined): Record<ToolName, WebMcpToolDefinition> {
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
        return {
          items: store.getDocument().nodes,
          summary: store.getSummary(),
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
        const document = store.upsertNodes(
          nodes.map((node) => toUpsertNodeInput(node)),
        );
        return {
          document,
          summary: store.getSummary(),
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
        const document = store.removeNodes(nodeIds);
        return {
          document,
          summary: store.getSummary(),
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
        return {
          items: store.getDocument().edges,
          summary: store.getSummary(),
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
        const document = store.upsertEdges(
          edges.map((edge) => toUpsertEdgeInput(edge)),
        );
        return {
          document,
          summary: store.getSummary(),
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
        const document = store.removeEdges(edgeIds);
        return {
          document,
          summary: store.getSummary(),
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
        const document = store.applyLayout(
          readLayoutMode(input),
          readLayoutScope(input),
        );
        return {
          document,
          summary: store.getSummary(),
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
        store.clear();
        return {
          document: store.getDocument(),
          summary: store.getSummary(),
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
        const exported = await store.exportDiagram(format, getExportApi());
        return {
          format,
          data: exported,
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

export async function registerBoardTools(
  modelContext: WebMcpModelContext,
  store: DiagramStore,
  getExportApi: () => ExportApi | undefined,
): Promise<void> {
  const existing = await modelContext.listTools();
  for (const name of TOOL_NAMES) {
    if (existing.some((tool) => tool.name === name)) {
      await modelContext.unregisterTool(name);
    }
  }

  const tools = createToolRegistry(store, getExportApi);
  for (const name of TOOL_NAMES) {
    await modelContext.registerTool(tools[name]);
  }
}
