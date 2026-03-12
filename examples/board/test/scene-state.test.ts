/**
 * This module verifies scene snapshot persistence and migration for the native board example.
 * It depends on the scene state and legacy model helpers so storage upgrades stay safe.
 */

import { vi } from "vitest";
import { createDemoDocument } from "../src/model.js";
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

describe("board scene state", () => {
  beforeEach(() => {
    vi.unmock("@excalidraw/excalidraw");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  it("migrates the legacy document storage into a scene snapshot", async () => {
    vi.doMock("@excalidraw/excalidraw", () => ({
      convertToExcalidrawElements: (elements: unknown[]) => elements,
    }));
    const storage = createMemoryStorage({
      "webmcp-bridge.board.document": JSON.stringify(createDemoDocument()),
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });

    const state = await BoardSceneState.load();

    expect(state.getSnapshot().elements.length).toBeGreaterThan(0);
    expect(storage.getItem("webmcp-bridge.board.scene")).toContain("elements");
    expect(storage.getItem("webmcp-bridge.board.document")).toBeNull();
  });
});
