import { expect, test } from "@playwright/test";

test.describe("admin ui navigation", () => {
  test("renders main page shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
  });
});
