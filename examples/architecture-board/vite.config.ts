/**
 * This module configures the Vite dev/build pipeline for the native architecture board example.
 * It depends on the React plugin and is used only by the example package scripts.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
