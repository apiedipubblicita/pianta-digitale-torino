import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          mappedin: ["@mappedin/mappedin-js"],
        },
      },
    },
  },
});
