import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core/vitest.config.ts",
      "packages/playwright/vitest.config.ts",
      "packages/adapter-fixture/vitest.config.ts",
      "packages/adapter-x/vitest.config.ts",
      "packages/local-mcp/vitest.config.ts",
      "packages/testkit/vitest.config.ts"
    ],
  },
});
