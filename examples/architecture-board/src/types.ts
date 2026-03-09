/**
 * This module defines the structured diagram and local WebMCP contracts used by the example app.
 * It is depended on by state, tool registration, Excalidraw interop, and tests.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type NodeKind = "actor" | "service" | "database" | "queue" | "cache" | "external";

export type DiagramNode = {
  id: string;
  label: string;
  kind: NodeKind;
  description?: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DiagramEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  protocol?: string;
};

export type DiagramDocument = {
  version: 1;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

export type DiagramSelection = {
  nodeIds: string[];
  edgeIds: string[];
};

export type DiagramSummary = {
  nodeCount: number;
  edgeCount: number;
  kinds: Record<NodeKind, number>;
};

export type DiagramExportFormat = "json" | "png";

export type LayoutMode = "layered" | "grid";

export type LayoutScope = "all" | "selection";

export type UpsertNodeInput = {
  id?: string;
  label: string;
  kind: NodeKind;
  description?: string;
  x?: number;
  y?: number;
};

export type UpsertEdgeInput = {
  id?: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  protocol?: string;
};

export type DiagramSnapshot = {
  document: DiagramDocument;
  selection: DiagramSelection;
};

export type WebMcpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: {
    readOnlyHint?: boolean;
  };
  execute: (input: JsonValue) => Promise<JsonValue>;
};

export type WebMcpModelContext = {
  provideContext: (context: JsonValue) => Promise<void>;
  clearContext: () => Promise<void>;
  registerTool: (tool: WebMcpToolDefinition) => Promise<void>;
  unregisterTool: (name: string) => Promise<void>;
  listTools: () => Promise<WebMcpToolDefinition[]>;
  callTool: (name: string, input: JsonValue) => Promise<JsonValue>;
};

export type ExcalidrawCustomData = {
  bridgeType: "node" | "edge" | "edge-label";
  bridgeId: string;
};
