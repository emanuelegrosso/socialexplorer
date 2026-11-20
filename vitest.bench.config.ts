import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/visualization-model/src/wx-072.bench.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});