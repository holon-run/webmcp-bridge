/**
 * This module defines Vitest coverage for the native board example.
 * It depends on the root Vitest runner so example-specific pure-unit tests join the workspace suite.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webmcp-bridge/core": new URL("../../packages/core/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/playwright": new URL("../../packages/playwright/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/local-mcp": new URL("../../packages/local-mcp/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/adapter-x": new URL("../../packages/adapter-x/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/adapter-fixture": new URL("../../packages/adapter-fixture/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/testkit": new URL("../../packages/testkit/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
