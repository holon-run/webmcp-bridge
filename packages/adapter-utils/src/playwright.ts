/**
 * This module provides reusable Playwright interception helpers for adapter network paths.
 * It keeps the helper focused on response capture and fulfillment, without embedding site-specific parsing logic.
 */

import type { Page, Route } from "playwright";

export type RoutedResponseCapture = {
  method: string;
  status: number;
  text: string;
};

export async function captureRoutedResponseText(
  page: Page,
  urlPattern: string,
  trigger: () => Promise<boolean>,
  options?: {
    timeoutMs?: number;
    shouldSkipRequest?: (method: string) => boolean;
  },
): Promise<RoutedResponseCapture | undefined> {
  let captured: RoutedResponseCapture | undefined;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const shouldSkipRequest = options?.shouldSkipRequest ?? ((method: string) => method === "OPTIONS");

  const routeHandler = async (route: Route) => {
    const method = route.request().method();
    if (shouldSkipRequest(method)) {
      await route.continue().catch(() => {});
      return;
    }

    const response = await route.fetch().catch(() => undefined);
    if (!response) {
      await route.continue().catch(() => {});
      return;
    }

    const text = await response.text().catch(() => "");
    captured = {
      method,
      status: response.status(),
      text,
    };

    await route.fulfill({ response }).catch(() => {});
  };

  await page.route(urlPattern, routeHandler);
  try {
    const triggerAccepted = await trigger();
    if (!triggerAccepted) {
      return undefined;
    }

    const start = Date.now();
    while (!captured && Date.now() - start < timeoutMs) {
      await page.waitForTimeout(100);
    }
    return captured;
  } finally {
    await page.unroute(urlPattern, routeHandler).catch(() => {});
  }
}
