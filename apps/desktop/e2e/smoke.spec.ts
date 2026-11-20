import { test, expect, type Page } from "@playwright/test";

const primaryNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test.describe("WX-070 renderer smoke (synthetic mock IPC)", () => {
  test("first-run demo is available on Home", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Story" })).toBeVisible();
    await expect(page.getByText("Synthetic demo is ready")).toBeVisible();
    await expect(page.getByLabel("Dataset")).toBeVisible();
  });

  test("archive import happy path via staged synthetic sample", async ({ page }) => {
    await page.goto("/");
    await primaryNav(page).getByRole("button", { name: "Archive Import" }).click();
    await page.getByRole("button", { name: "Load synthetic sample" }).click();
    await expect(page.getByRole("heading", { name: /synthetic-android-private/u })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Build merge plan" }).click();
    await page.getByRole("button", { name: "Commit import" }).click();
    await expect(page.getByText(/Committed \d+ messages/u)).toBeVisible();
  });

  test("Temporal Flow and Analytics navigation", async ({ page }) => {
    await page.goto("/");
    await primaryNav(page).getByRole("button", { name: "Timeline" }).click();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    await expect(page.getByLabel("Search")).toBeVisible();
    await expect(page.getByRole("button", { name: "Static" })).toBeVisible();

    await primaryNav(page).getByRole("button", { name: "Analytics" }).click();
    await expect(page.getByRole("heading", { name: "Analytics", level: 2 })).toBeVisible();
    await expect(page.getByText("Total messages")).toBeVisible();
  });

  test("Memories gallery loads catalog filters", async ({ page }) => {
    await page.goto("/");
    await primaryNav(page).getByRole("button", { name: "Memories" }).click();
    await expect(page.getByRole("heading", { name: "Memories", level: 2 })).toBeVisible();
    await expect(page.getByRole("region", { name: "On This Day" })).toBeVisible();
    await expect(page.getByText("Media type")).toBeVisible();
  });
});