import { expect, test } from "@playwright/test";

const shouldSkip = Boolean(process.env.CI);

test.describe("admin ui navigation", () => {
  test.skip(shouldSkip, "Requires running admin server (localhost)");
  
  test("renders main page shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
  });
});
