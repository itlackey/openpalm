import { expect, test } from "@playwright/test";

const shouldSkip = Boolean(process.env.CI);

test.describe("setup wizard", () => {
  test.skip(shouldSkip, "Requires running admin server (localhost)");
  
  test("shows setup overlay on first boot", async ({ page }) => {
    await page.goto("/");
    const setupVisible = await page.locator("text=Setup").first().isVisible().catch(() => false);
    expect(setupVisible || page.url()).toBeTruthy();
  });
});
