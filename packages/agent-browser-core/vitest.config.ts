import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webmcp-bridge/agent-browser-core": new URL("../agent-browser-core/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/playwright": new URL("../playwright/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
