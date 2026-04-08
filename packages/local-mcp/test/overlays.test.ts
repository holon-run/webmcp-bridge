/**
 * This module tests persisted overlay storage and page-context overlay/debug script execution.
 * It depends on the overlay store helpers so local-mcp can evolve draft tools without widening the Playwright MCP surface.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  evaluateDebugScript,
  evaluateOverlayTool,
  OverlayStore,
  readOverlayFile,
} from "../src/overlays.js";

function createPageStub(): Page {
  return {
    evaluate: async (pageFunction: (payload: unknown) => Promise<string>, payload: unknown) => await pageFunction(payload),
  } as unknown as Page;
}

describe("OverlayStore", () => {
  let profileDir: string | undefined;

  afterEach(async () => {
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true });
      profileDir = undefined;
    }
  });

  it("reports persistence unavailable without a managed profile", async () => {
    const store = new OverlayStore("board");
    await store.load();

    expect(store.list()).toEqual({
      overlays: [],
      persistence: {
        available: false,
        reason: "managed_profile_required",
      },
    });
    await expect(
      store.install({
        id: "board-fix",
        tools: [{ name: "diagram.get", script: "() => ({ ok: true })" }],
      }),
    ).rejects.toThrow("CONFIG_ERROR: overlays require a managed profile session");
  });

  it("persists overlays and reloads them from disk", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "webmcp-overlay-store-"));
    const store = new OverlayStore("board", profileDir);
    await store.load();

    const overlay = await store.install({
      id: "board_fix",
      description: "Board fallback",
      activation: "override",
      tools: [
        {
          name: "diagram.get",
          description: "Read board state",
          inputSchema: { type: "object", additionalProperties: false },
          script: "() => ({ ok: true, source: 'overlay' })",
        },
      ],
    });

    expect(overlay.id).toBe("board_fix");
    expect(overlay.activation).toBe("override");
    expect(store.listEnabledAliasToolDefinitions()).toEqual([
      {
        name: "overlay.board_fix.diagram.get",
        description: "Read board state",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ]);

    const persisted = await readOverlayFile(profileDir, "board_fix", "board");
    expect(persisted).toMatchObject({
      id: "board_fix",
      siteId: "board",
      enabled: true,
      activation: "override",
    });

    const raw = await readFile(join(profileDir, ".webmcp-bridge", "overlays", "board_fix.json"), "utf8");
    expect(raw).toContain("\"diagram.get\"");

    const reloaded = new OverlayStore("board", profileDir);
    await reloaded.load();
    expect(reloaded.list()).toMatchObject({
      overlays: [
        {
          id: "board_fix",
          siteId: "board",
          enabled: true,
          activation: "override",
        },
      ],
      persistence: {
        available: true,
        profilePath: profileDir,
      },
    });
  });

  it("can disable and delete overlays", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "webmcp-overlay-store-"));
    const store = new OverlayStore("board", profileDir);
    await store.load();
    await store.install({
      id: "board_fix",
      tools: [{ name: "diagram.get", script: "() => ({ ok: true })" }],
    });

    await store.disable("board_fix");
    expect(store.listEnabledAliasToolDefinitions()).toEqual([]);

    await store.delete("board_fix");
    expect(store.list().overlays).toEqual([]);
  });

  it("rejects conflicting override overlays for the same tool name", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "webmcp-overlay-store-"));
    const store = new OverlayStore("board", profileDir);
    await store.load();
    await store.install({
      id: "board_fix",
      activation: "override",
      tools: [{ name: "diagram.get", script: "() => ({ ok: true })" }],
    });

    await expect(
      store.install({
        id: "board_fix_2",
        activation: "override",
        tools: [{ name: "diagram.get", script: "() => ({ ok: false })" }],
      }),
    ).rejects.toThrow("OVERLAY_OVERRIDE_CONFLICT");
  });

  it("applies override tools canonically while preserving alias tools", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "webmcp-overlay-store-"));
    const store = new OverlayStore("board", profileDir);
    await store.load();
    await store.install({
      id: "board_fix",
      activation: "override",
      tools: [{ name: "diagram.get", script: "() => ({ ok: true })" }],
    });

    expect(
      store.applyOverrideToolDefinitions([
        { name: "diagram.get", description: "base tool" },
        { name: "diagram.list", description: "list tool" },
      ]),
    ).toEqual([
      { name: "diagram.get", inputSchema: { type: "object" } },
      { name: "diagram.list", description: "list tool" },
    ]);
    expect(store.list(["diagram.get", "diagram.list"]).overlays[0]).toMatchObject({
      activation: "override",
      toolNames: ["diagram.get"],
      shadowedTools: ["diagram.get"],
      aliasPrefix: "overlay.board_fix",
    });
  });

  it("exports a persisted overlay as an adapter draft directory", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "webmcp-overlay-store-"));
    const store = new OverlayStore("board", profileDir);
    await store.load();
    const overlay = await store.install({
      id: "board_fix",
      tools: [{ name: "diagram.get", script: "() => ({ ok: true })" }],
    });

    const exported = await store.exportAdapterDraft({
      id: overlay.id,
      targetUrl: "https://board.holon.run",
      siteDisplayName: "Board",
      hostPatterns: ["board.holon.run"],
    });

    expect(exported).toMatchObject({
      format: "adapter-draft",
      overlay: {
        id: "board_fix",
      },
    });
    const generatedEntry = await readFile(exported.entryFile, "utf8");
    expect(generatedEntry).toContain("export const manifest");
    expect(generatedEntry).toContain("\"diagram.get\"");
    const generatedPackage = JSON.parse(await readFile(join(exported.outputDir, "package.json"), "utf8")) as {
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(generatedPackage.private).toBe(true);
    expect(generatedPackage.dependencies["@webmcp-bridge/playwright"]).toBe("^0.7.0");
  });
});

describe("overlay script execution", () => {
  it("runs debug eval scripts in page context", async () => {
    await expect(
      evaluateDebugScript(createPageStub(), "(args) => ({ query: args.query, ok: true })", { query: "openai" }),
    ).resolves.toEqual({
      query: "openai",
      ok: true,
    });
  });

  it("runs overlay tool scripts in page context", async () => {
    await expect(
      evaluateOverlayTool(
        createPageStub(),
        {
          id: "board_fix",
          siteId: "board",
          enabled: true,
          activation: "namespaced",
          tools: [{ name: "diagram.get", script: "() => ({ ok: true })" }],
          createdAt: "2026-04-06T00:00:00.000Z",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
        {
          name: "diagram.get",
          script: "(input) => ({ title: input.title, ok: true })",
        },
        { title: "Roadmap" },
      ),
    ).resolves.toEqual({
      title: "Roadmap",
      ok: true,
    });
  });
});
