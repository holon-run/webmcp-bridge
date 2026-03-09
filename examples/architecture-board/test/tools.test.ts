/**
 * This module verifies the native architecture board WebMCP tool registration contract.
 * It depends on the in-memory modelContext and store so tool names and result shapes remain stable.
 */

import { ensureModelContext } from "../src/model-context.js";
import { DiagramStore } from "../src/state.js";
import { registerArchitectureBoardTools } from "../src/tools.js";

describe("architecture board tools", () => {
  beforeEach(() => {
    delete (globalThis as { __webmcpArchitectureBoardModelContext?: unknown }).__webmcpArchitectureBoardModelContext;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });
  });

  it("registers the MVP toolset", async () => {
    const modelContext = ensureModelContext(globalThis);
    const store = DiagramStore.load();

    await registerArchitectureBoardTools(modelContext, store, () => undefined);

    const tools = await modelContext.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "nodes.list",
      "nodes.upsert",
      "edges.list",
      "edges.upsert",
      "layout.apply",
      "diagram.export",
    ]);
  });

  it("returns structured node data from nodes.list", async () => {
    const modelContext = ensureModelContext(globalThis);
    const store = DiagramStore.load();

    await registerArchitectureBoardTools(modelContext, store, () => undefined);
    const result = await modelContext.callTool("nodes.list", {});

    expect(result).toMatchObject({
      items: expect.any(Array),
      summary: {
        nodeCount: expect.any(Number),
        edgeCount: expect.any(Number),
      },
    });
  });
});
