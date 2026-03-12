/**
 * This module verifies the local board UI stays renderable after WebMCP-driven document updates and reloads.
 * It depends on the Vite dev server and Playwright browser automation so front-end regressions are caught outside the MCP bridge tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const EXAMPLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 90_000;

async function startExampleServer(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    root: EXAMPLE_ROOT,
    configFile: resolve(EXAMPLE_ROOT, "vite.config.ts"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve Vite dev server address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function waitForBoardReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const heading = document.querySelector("h1");
    return heading?.textContent === "Board";
  });
  await page.waitForFunction(() => {
    const anyNavigator = navigator as Navigator & {
      modelContext?: { callTool?: (name: string, input: unknown) => Promise<unknown> };
    };
    return typeof anyNavigator.modelContext?.callTool === "function";
  });
}

describe("board ui stability", () => {
  let server: ViteDevServer | undefined;
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;
  let userDataDir: string | undefined;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const startedServer = await startExampleServer();
    server = startedServer.server;
    userDataDir = await mkdtemp(resolve(tmpdir(), "webmcp-bridge-board-ui-"));
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
    });
    page = browserContext.pages()[0] ?? (await browserContext.newPage());
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(startedServer.url, { waitUntil: "domcontentloaded" });
    await waitForBoardReady(page);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browserContext?.close();
    await server?.close();
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it(
    "stays renderable after tool-driven updates and reload",
    async () => {
      await page!.evaluate(async () => {
        const modelContext = (navigator as Navigator & {
          modelContext: { callTool: (name: string, input: unknown) => Promise<unknown> };
        }).modelContext;
        await modelContext.callTool("nodes.upsert", {
          nodes: [
            { id: "client", label: "AI / MCP Client", kind: "actor", x: 80, y: 100 },
            { id: "gateway", label: "local-mcp", kind: "service", x: 380, y: 100 },
            { id: "playwright", label: "Playwright Gateway", kind: "service", x: 680, y: 100 },
            { id: "native", label: "navigator.modelContext", kind: "service", x: 980, y: 320 },
            { id: "adapter", label: "Fallback Adapter", kind: "service", x: 980, y: 100 },
            { id: "site", label: "Target Site", kind: "external", x: 680, y: 320 },
          ],
        });
        await modelContext.callTool("edges.upsert", {
          edges: [
            { id: "e1", sourceNodeId: "client", targetNodeId: "gateway", protocol: "stdio MCP" },
            { id: "e2", sourceNodeId: "gateway", targetNodeId: "playwright", protocol: "runtime control" },
            { id: "e3", sourceNodeId: "playwright", targetNodeId: "native", protocol: "native call" },
            { id: "e4", sourceNodeId: "playwright", targetNodeId: "adapter", protocol: "shim fallback" },
            { id: "e5", sourceNodeId: "native", targetNodeId: "site", protocol: "tool execution" },
            { id: "e6", sourceNodeId: "adapter", targetNodeId: "site", protocol: "browser fetch / DOM" },
          ],
        });
      });

      await page!.reload({ waitUntil: "domcontentloaded" });
      await waitForBoardReady(page!);

      const summaryText = await page!.locator("body").innerText();
      expect(summaryText).toContain("Board");
      expect(summaryText).toContain("Show Panel");
      expect(pageErrors).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders tool-driven updates without requiring a page reload",
    async () => {
      await page!.evaluate(async () => {
        const modelContext = (navigator as Navigator & {
          modelContext: { callTool: (name: string, input: unknown) => Promise<unknown> };
        }).modelContext;
        await modelContext.callTool("diagram.reset", {});
        await modelContext.callTool("nodes.upsert", {
          nodes: [
            { id: "instant-client", label: "Instant Client", kind: "actor", x: 120, y: 120 },
            { id: "instant-bridge", label: "Instant Bridge", kind: "service", x: 520, y: 120 },
          ],
        });
      });

      await page!.waitForFunction(() => {
        const api = (window as Window & {
          __excalidrawAPI?: { getSceneElements?: () => unknown[] };
        }).__excalidrawAPI;
        const elements = api?.getSceneElements?.() ?? [];
        return elements.length >= 2;
      });

      expect(pageErrors).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
