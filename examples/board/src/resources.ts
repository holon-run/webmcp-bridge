/**
 * This module defines and registers the native board WebMCP resources.
 * It depends on the scene and interaction state stores so browser and local bridge clients can subscribe to host-relevant board state.
 */

import type { BoardInteractionsState } from "./interactions-state.js";
import type { BoardSceneState } from "./scene-state.js";
import { deriveDocumentFromScene, deriveSelection, deriveSummaryFromScene } from "./excalidraw.js";
import type {
  JsonValue,
  WebMcpModelContext,
  WebMcpResourceDefinition,
} from "./types.js";

export const BOARD_RESOURCE_URIS = {
  scene: "board://local/scene",
  selection: "board://local/selection",
  interactions: "board://local/interactions",
} as const;

function createResourceRegistry(
  sceneState: BoardSceneState,
  interactionsState: BoardInteractionsState,
): Record<(typeof BOARD_RESOURCE_URIS)[keyof typeof BOARD_RESOURCE_URIS], WebMcpResourceDefinition> {
  return {
    [BOARD_RESOURCE_URIS.scene]: {
      uri: BOARD_RESOURCE_URIS.scene,
      name: "Board Scene",
      description: "Current structured board scene snapshot and derived summary.",
      mimeType: "application/json",
      read: async (): Promise<JsonValue> => {
        const scene = sceneState.getSnapshot();
        return {
          title: scene.title,
          document: deriveDocumentFromScene(scene),
          summary: deriveSummaryFromScene(scene),
        };
      },
    },
    [BOARD_RESOURCE_URIS.selection]: {
      uri: BOARD_RESOURCE_URIS.selection,
      name: "Board Selection",
      description: "Current selected nodes and edges for the active board session.",
      mimeType: "application/json",
      read: async (): Promise<JsonValue> => {
        const snapshot = sceneState.getSnapshot();
        const selection = deriveSelection(snapshot, sceneState.getSelectedElementIds());
        return selection;
      },
    },
    [BOARD_RESOURCE_URIS.interactions]: {
      uri: BOARD_RESOURCE_URIS.interactions,
      name: "Board Interactions",
      description: "Recent user-authored messages and annotations anchored to board selections.",
      mimeType: "application/json",
      read: async (): Promise<JsonValue> => interactionsState.getSnapshot() as JsonValue,
    },
  };
}

export async function registerBoardResources(
  modelContext: WebMcpModelContext,
  sceneState: BoardSceneState,
  interactionsState: BoardInteractionsState,
): Promise<void> {
  const existing = await modelContext.listResources();
  for (const uri of Object.values(BOARD_RESOURCE_URIS)) {
    if (existing.some((resource) => resource.uri === uri)) {
      await modelContext.unregisterResource(uri);
    }
  }

  const resources = createResourceRegistry(sceneState, interactionsState);
  for (const uri of Object.values(BOARD_RESOURCE_URIS)) {
    await modelContext.registerResource(resources[uri]);
  }
}
