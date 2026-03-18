import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webmcp-bridge/adapter-utils": new URL("./src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
