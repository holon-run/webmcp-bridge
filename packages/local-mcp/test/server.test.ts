/**
 * This module tests the local-mcp skeleton in-memory tool routing behavior.
 * It depends on the server factory to validate list and call semantics.
 */

import { describe, expect, it } from "vitest";
import { createLocalMcpServer } from "../src/index.js";

describe("createLocalMcpServer", () => {
  it("calls registered tools", async () => {
    const server = createLocalMcpServer({
      tools: [{ name: "x.health", execute: async () => ({ ok: true }) }],
    });
    expect(server.listTools().map((t) => t.name)).toEqual(["x.health"]);
    await expect(server.callTool("x.health", {})).resolves.toEqual({ ok: true });
  });
});
