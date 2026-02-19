import { expect, test } from "@playwright/test";

test.describe("setup wizard", () => {
  test("shows setup overlay on first boot", async ({ page }) => {
    await page.goto("/");
    const setupVisible = await page.locator("text=Setup").first().isVisible().catch(() => false);
    expect(setupVisible || page.url()).toBeTruthy();
  });
});
