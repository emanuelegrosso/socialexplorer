import { defineConfig, devices } from "@playwright/test";

const previewHost = "127.0.0.1";
const previewPort = 4173;
const isCi = Boolean(process.env["CI"]);

/** In CI, workflow runs root `pnpm build` (includes renderer). Locally, build inside webServer if needed. */
const previewCmd =
  "pnpm exec vite preview --config vite.config.ts --host 127.0.0.1 --port 4173";
const webServerCommand = isCi
  ? previewCmd
  : `pnpm exec vite build && ${previewCmd}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: 1,
  reporter: isCi ? "github" : "list",
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
    command: webServerCommand,
    url: `http://${previewHost}:${String(previewPort)}`,
    reuseExistingServer: !isCi,
    timeout: 180_000,
    cwd: import.meta.dirname,
    stdout: "pipe",
    stderr: "pipe",
  },
});