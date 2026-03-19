/**
 * This module defines the board scene, derived diagram view, and local WebMCP contracts used by the example app.
 * It is depended on by scene state, Excalidraw interop, tool registration, and tests.
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
  style?: DiagramNodeStyle;
};

export type DiagramEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  protocol?: string;
  style?: DiagramEdgeStyle;
};

export type DiagramNodeStyle = {
  strokeColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  roughness?: number;
  opacity?: number;
};

export type DiagramEdgeStyle = {
  strokeColor?: string;
  textColor?: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
  strokeWidth?: number;
  opacity?: number;
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

export type InteractionKind = "message" | "annotation";

export type InteractionAudience = "human" | "host" | "both";

export type InteractionIntent = "inform" | "request_action";

export type InteractionAuthor = "user" | "assistant" | "system";

export type InteractionAnchor = {
  nodeIds: string[];
  edgeIds: string[];
};

export type BoardInteraction = {
  id: string;
  kind: InteractionKind;
  body: string;
  author: InteractionAuthor;
  createdAt: string;
  anchors: InteractionAnchor;
  routing: {
    audience: InteractionAudience;
  };
  intent: InteractionIntent;
  requiresResponse: boolean;
};

export type BoardInteractionsSnapshot = {
  version: 1;
  appId: "board";
  sessionId: string;
  resourceVersion: number;
  updatedAt: string;
  items: BoardInteraction[];
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
  label?: string;
  kind?: NodeKind;
  description?: string;
  x?: number;
  y?: number;
};

export type UpsertEdgeInput = {
  id?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  label?: string;
  protocol?: string;
};

export type NodeStylePatch = DiagramNodeStyle & {
  nodeIds: string[];
};

export type EdgeStylePatch = DiagramEdgeStyle & {
  edgeIds: string[];
};

export type ResizeNodeInput = {
  nodeIds: string[];
  width?: number;
  height?: number;
};

export type CanvasStylePatch = {
  backgroundColor?: string;
};

export type FitViewInput = {
  animate?: boolean;
  viewportZoomFactor?: number;
};

export type BoardSceneAppState = {
  viewBackgroundColor?: string;
  scrollX?: number;
  scrollY?: number;
  zoom?: number;
};

export type BoardSceneSnapshot = {
  version: 1;
  title: string;
  elements: unknown[];
  appState: BoardSceneAppState;
};

export type BoardSnapshot = {
  scene: BoardSceneSnapshot;
  selection: DiagramSelection;
  selectedElementIds: string[];
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

export type WebMcpResourceDefinition = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<JsonValue>;
};

export type WebMcpModelContext = {
  provideContext: (context: JsonValue) => Promise<void>;
  clearContext: () => Promise<void>;
  registerTool: (tool: WebMcpToolDefinition) => Promise<void>;
  unregisterTool: (name: string) => Promise<void>;
  listTools: () => Promise<WebMcpToolDefinition[]>;
  callTool: (name: string, input: JsonValue) => Promise<JsonValue>;
  registerResource: (resource: WebMcpResourceDefinition) => Promise<void>;
  unregisterResource: (uri: string) => Promise<void>;
  listResources: () => Promise<Array<Omit<WebMcpResourceDefinition, "read">>>;
  readResource: (uri: string) => Promise<JsonValue>;
  notifyResourceUpdated: (uri: string) => Promise<void>;
};

export type ExcalidrawNodeCustomData = {
  bridgeType: "node";
  bridgeId: string;
  nodeKind: NodeKind;
  description?: string;
};

export type ExcalidrawEdgeCustomData = {
  bridgeType: "edge";
  bridgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  protocol?: string;
};

export type ExcalidrawCustomData = ExcalidrawNodeCustomData | ExcalidrawEdgeCustomData;
