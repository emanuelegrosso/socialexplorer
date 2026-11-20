import { defineConfig, devices } from "@playwright/test";

const previewHost = "127.0.0.1";
const previewPort = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://${previewHost}:${String(previewPort)}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "renderer-smoke",
      testIgnore: "**/webgl.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "temporal-webgl",
      testMatch: "**/webgl.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Renderer preview only (mock IPC); workspace packages must already be built (`pnpm build` at repo root).
    command:
      "pnpm exec vite build && pnpm exec vite preview --config vite.config.ts --host 127.0.0.1 --port 4173",
    url: `http://${previewHost}:${String(previewPort)}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
    cwd: import.meta.dirname,
  },
});