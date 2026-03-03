/**
 * This module implements a starter X/Twitter site adapter.
 * It depends on Playwright page evaluation and bridge adapter types to map site actions into tool calls.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { SiteAdapter } from "@webmcp-bridge/playwright";
import type { Page } from "playwright";

type XAuthState = "authenticated" | "auth_required";

async function detectAuth(page: Page): Promise<XAuthState> {
  const isAuthed = await page.evaluate(() => {
    const hasComposer = Boolean(document.querySelector("[data-testid='tweetTextarea_0']"));
    const hasNav = Boolean(document.querySelector("nav[aria-label='Primary']"));
    return hasComposer || hasNav;
  });
  return isAuthed ? "authenticated" : "auth_required";
}

export function createXAdapter(): SiteAdapter {
  return {
    name: "adapter-x",
    listTools: async () => [
      { name: "x.health", description: "Get adapter health" },
      { name: "x.auth_state", description: "Get login state" },
      { name: "x.timeline.read", description: "Read timeline text snippets" },
      { name: "x.compose.send", description: "Publish a text post" },
    ],
    callTool: async ({ name, input }, { page }) => {
      if (name === "x.health") {
        return { ok: true, adapter: "x" };
      }

      if (name === "x.auth_state") {
        return { state: await detectAuth(page) };
      }

      if (name === "x.timeline.read") {
        const state = await detectAuth(page);
        if (state !== "authenticated") {
          return { error: { code: "AUTH_REQUIRED", message: "login required" } };
        }
        const limit =
          typeof (input as { limit?: number }).limit === "number"
            ? Math.max(1, Math.min(20, (input as { limit?: number }).limit ?? 10))
            : 10;

        const items = await page.evaluate((maxItems) => {
          const nodes = Array.from(document.querySelectorAll("article [data-testid='tweetText']"));
          return nodes.slice(0, maxItems).map((node, index) => ({
            id: `timeline-${index + 1}`,
            text: node.textContent?.trim() ?? "",
          }));
        }, limit);
        return { items };
      }

      if (name === "x.compose.send") {
        const state = await detectAuth(page);
        if (state !== "authenticated") {
          return { error: { code: "AUTH_REQUIRED", message: "login required" } };
        }

        const text = typeof (input as { text?: string }).text === "string" ? (input as { text: string }).text : "";
        if (!text.trim()) {
          return { error: { code: "VALIDATION_ERROR", message: "text is required" } };
        }

        const result = await page.evaluate(async (messageText) => {
          const composer = document.querySelector<HTMLElement>("[data-testid='tweetTextarea_0']");
          const submit = document.querySelector<HTMLElement>("[data-testid='tweetButtonInline']");
          if (!composer || !submit) {
            return { ok: false, reason: "composer_not_found" };
          }
          composer.focus();
          document.execCommand("insertText", false, messageText);
          submit.click();
          return { ok: true };
        }, text);

        if (!result.ok) {
          return { error: { code: "UPSTREAM_CHANGED", message: "compose controls not found" } };
        }

        return {
          ok: true,
          messageId: `x_${Date.now()}`,
        } satisfies JsonValue;
      }

      return { error: { code: "TOOL_NOT_FOUND", message: `unknown tool: ${name}` } };
    },
  };
}
