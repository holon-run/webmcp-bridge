/**
 * This module defines Vitest coverage for the native board example.
 * It depends on the root Vitest runner so example-specific pure-unit tests join the workspace suite.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
