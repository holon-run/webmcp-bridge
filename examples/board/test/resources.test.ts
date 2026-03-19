/**
 * This module verifies the native board WebMCP resource registration contract.
 * It depends on the in-memory modelContext plus board state stores so resource URIs and payload shapes remain stable.
 */

import { vi } from "vitest";
import { BoardInteractionsState } from "../src/interactions-state.js";
import { ensureModelContext } from "../src/model-context.js";
import { BOARD_RESOURCE_URIS, registerBoardResources } from "../src/resources.js";
import { BoardSceneState } from "../src/scene-state.js";

type MemoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function createMemoryStorage(seed: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("board resources", () => {
  beforeEach(() => {
    vi.unmock("@excalidraw/excalidraw");
    delete (globalThis as { __webmcpBoardModelContext?: unknown }).__webmcpBoardModelContext;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  it("registers scene, selection, and interactions resources", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();
    const interactionsState = await BoardInteractionsState.load();

    await registerBoardResources(modelContext, sceneState, interactionsState);

    const resources = await modelContext.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      BOARD_RESOURCE_URIS.scene,
      BOARD_RESOURCE_URIS.selection,
      BOARD_RESOURCE_URIS.interactions,
    ]);
  });

  it("returns persisted interactions from the interactions resource", async () => {
    const modelContext = ensureModelContext(globalThis);
    const sceneState = await BoardSceneState.load();
    const interactionsState = await BoardInteractionsState.load();
    interactionsState.appendInteraction({
      kind: "message",
      body: "Expand the selected services into a fuller design.",
      selection: { nodeIds: ["gateway"], edgeIds: [] },
      audience: "host",
      intent: "request_action",
      requiresResponse: true,
    });

    await registerBoardResources(modelContext, sceneState, interactionsState);
    const resource = await modelContext.readResource(BOARD_RESOURCE_URIS.interactions);

    expect(resource).toMatchObject({
      version: 1,
      appId: "board",
      sessionId: "local",
      resourceVersion: 1,
      items: [
        expect.objectContaining({
          body: "Expand the selected services into a fuller design.",
          intent: "request_action",
          routing: {
            audience: "host",
          },
        }),
      ],
    });
  });
});
