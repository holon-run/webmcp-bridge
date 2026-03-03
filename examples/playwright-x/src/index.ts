/**
 * This module demonstrates running the bridge on a Playwright-driven X session.
 * It depends on the playwright bridge package and adapter-x to provide a minimal manual smoke example.
 */

import { chromium } from "playwright";
import { attachBridge, detachBridge } from "@webmcp-bridge/playwright";
import { createXAdapter } from "@webmcp-bridge/adapter-x";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });

  const session = await attachBridge(page, {
    adapter: createXAdapter(),
  });

  const health = await session.adapter.callTool({ name: "x.health", input: {} }, { page });
  process.stdout.write(`bridge mode=${session.mode} health=${JSON.stringify(health)}\n`);

  await detachBridge(page);
  await context.close();
  await browser.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
