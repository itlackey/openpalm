import { expect, test } from "@playwright/test";

test.describe("setup wizard", () => {
  test("shows setup overlay on first boot", async ({ page }) => {
    await page.goto("http://localhost:3000");
    await expect(page.locator("text=Setup")).toBeVisible();
  });
});
