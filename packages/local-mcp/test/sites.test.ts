/**
 * This module tests built-in and external site-source resolution behavior.
 * It depends on site resolver APIs and temporary module fixtures to validate dynamic adapter loading.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeSiteDefinition, resolveSiteSource } from "../src/sites.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempAdapterModule(contents: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "local-mcp-site-test-"));
  tempDirs.push(dir);
  const path = join(dir, "adapter.mjs");
  await writeFile(path, contents, "utf8");
  return { dir, path };
}

describe("resolveSiteSource", () => {
  it("resolves built-in site", async () => {
    const site = await resolveSiteSource({ site: "x" });
    expect(site.source).toBe("builtin");
    expect(site.id).toBe("x");
  });

  it("resolves external adapter module by relative path", async () => {
    const module = await createTempAdapterModule(`
      export const manifest = {
        id: "example.com",
        displayName: "Example",
        version: "0.1.0",
        bridgeApiVersion: "1.0.0",
        defaultUrl: "https://example.com",
        hostPatterns: ["example.com"],
        authProbeTool: "auth.get"
      };

      export function createAdapter() {
        return {
          name: "adapter-example",
          listTools: async () => [{ name: "auth.get", inputSchema: { type: "object" } }],
          callTool: async () => ({ state: "authenticated" })
        };
      }
    `);

    const site = await resolveSiteSource({
      adapterModule: "./adapter.mjs",
      moduleBaseDir: module.dir,
    });

    expect(site.source).toBe("external");
    expect(site.id).toBe("example.com");
    expect(site.manifest.authProbeTool).toBe("auth.get");
    expect(typeof site.createFallbackAdapter).toBe("function");
  });

  it("throws when both site and adapter-module are provided", async () => {
    await expect(
      resolveSiteSource({
        site: "x",
        adapterModule: "./adapter.mjs",
      }),
    ).rejects.toThrow("CONFIG_ERROR: use either --site or --adapter-module, not both");
  });

  it("supports default-export adapter module shape", async () => {
    const module = await createTempAdapterModule(`
      export default {
        manifest: {
          id: "default-export.example",
          displayName: "Default Export",
          version: "0.1.0",
          bridgeApiVersion: "1.0.0",
          hostPatterns: ["default-export.example"]
        },
        createAdapter() {
          return {
            name: "adapter-default-export",
            listTools: async () => [],
            callTool: async () => ({ ok: true })
          };
        }
      };
    `);

    const site = await resolveSiteSource({
      adapterModule: module.path,
    });
    expect(site.id).toBe("default-export.example");
    expect(site.source).toBe("external");
  });

  it("throws when adapter module contract is invalid", async () => {
    const module = await createTempAdapterModule(`
      export const manifest = {
        id: "invalid",
        displayName: "Invalid",
        version: "0.1.0",
        bridgeApiVersion: "1.0.0",
        hostPatterns: ["invalid.test"]
      };
    `);

    await expect(
      resolveSiteSource({
        adapterModule: module.path,
      }),
    ).rejects.toThrow("ADAPTER_CONTRACT_ERROR: adapter module must export createAdapter()");
  });
});

describe("createNativeSiteDefinition", () => {
  it("creates native-only definition from https url", () => {
    const site = createNativeSiteDefinition("https://www.meetcursive.com");
    expect(site.source).toBe("native");
    expect(site.manifest.defaultUrl).toBe("https://www.meetcursive.com/");
    expect(site.manifest.hostPatterns).toEqual(["www.meetcursive.com"]);
    expect(site.createFallbackAdapter).toBeUndefined();
  });

  it("supports about:blank", () => {
    const site = createNativeSiteDefinition("about:blank");
    expect(site.manifest.hostPatterns).toEqual(["about:blank"]);
  });

  it("rejects invalid url", () => {
    expect(() => createNativeSiteDefinition("not-a-url")).toThrow(
      "CONFIG_ERROR: --url must be a valid absolute URL",
    );
  });
});
