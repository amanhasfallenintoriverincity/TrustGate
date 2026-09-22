import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Orchestrator dev server origin. The dashboard reaches it through the /api proxy
 * below. Defaults to the orchestrator port from apps/orchestrator/src/main.ts
 * (TRUSTGATE_PORT ?? 8787); override with TRUSTGATE_DEV_ORIGIN when it runs elsewhere.
 */
const ORCHESTRATOR_DEV_ORIGIN = process.env.TRUSTGATE_DEV_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: ORCHESTRATOR_DEV_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
