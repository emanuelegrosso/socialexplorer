import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    lib: {
      entry: "electron/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rolldownOptions: {
      external: ["electron"],
    },
  },
});
