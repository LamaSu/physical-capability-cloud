import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Sentry source map upload — only active when SENTRY_AUTH_TOKEN is set.
    // This uploads source maps to Sentry after each production build so stack
    // traces in the Sentry UI resolve to original TypeScript line numbers.
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // @pcc/spec is Node-first (uses node:crypto.createHash for sha256).
      // Map node:crypto -> a tiny browser-compatible shim so vite/rollup
      // can bundle the runtime helpers (computeScheduleHash,
      // evaluateRateSchedule) used by RateSchedule pages.
      "node:crypto": path.resolve(__dirname, "./src/lib/node-crypto-shim.ts"),
    },
  },
  build: {
    // Source maps are required for Sentry to resolve minified stack traces.
    // When SENTRY_AUTH_TOKEN is not set (e.g. local dev) they are still
    // generated but not uploaded — this has no security impact for SPAs
    // served from a CDN without exposing the .map files.
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-charts": ["recharts"],
          "vendor-flow": ["@xyflow/react"],
          "vendor-motion": ["framer-motion"],
          "vendor-wagmi": ["wagmi", "viem"],
          "vendor-telemetry": ["posthog-js", "@sentry/react"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3200",
        changeOrigin: true,
      },
      "/sse": {
        target: "http://localhost:3200",
        changeOrigin: true,
      },
    },
  },
});
