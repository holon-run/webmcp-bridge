import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webmcp-bridge/core": new URL("../core/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/playwright": new URL("../playwright/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/local-mcp": new URL("../local-mcp/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/adapter-x": new URL("../adapter-x/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/adapter-fixture": new URL("../adapter-fixture/src/index.ts", import.meta.url).pathname,
      "@webmcp-bridge/testkit": new URL("../testkit/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
