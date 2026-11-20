import { test, expect } from "@playwright/test";

/**
 * Optional GPU path: Chromium in CI often exposes software WebGL; when unavailable the canvas host
 * falls back gracefully — we only assert the scene shell mounts.
 */
test.describe("Temporal WebGL shell", () => {
  test("timeline mounts a canvas when WebGL is available", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Timeline" }).click();

    const webgl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
    });

    test.skip(!webgl, "No WebGL context in this runner — timeline UI smoke runs in renderer-smoke project.");

    await expect(page.locator(".temporal-canvas")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByRole("img", { name: /Temporal interaction flow/i })).toBeVisible();
  });
});