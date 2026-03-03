/**
 * This module demonstrates running the native-first WebMCP page gateway on a Playwright-driven X session.
 * It depends on the playwright gateway API and adapter-x as a real shim fallback implementation.
 */

import { chromium } from "playwright";
import { createWebMcpPageGateway } from "@webmcp-bridge/playwright";
import { createXAdapter } from "@webmcp-bridge/adapter-x";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });

  const gateway = await createWebMcpPageGateway(page, {
    fallbackAdapter: createXAdapter(),
  });

  const health = await gateway.callTool("x.health", {});
  process.stdout.write(`gateway mode=${gateway.mode} health=${JSON.stringify(health)}\n`);

  await gateway.close();
  await context.close();
  await browser.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
