import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "../../../.dev/data/admin/setup-state.json");

const ADMIN_TOKEN = "dev-admin-token";
const ADMIN_URL = "http://localhost/admin/";

test.describe("Setup Wizard", () => {
  // Reset state before each run of this suite so the wizard always appears
  test.beforeAll(() => {
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
  });

  // Wizard runs compose operations — allow plenty of time
  test.setTimeout(180_000);

  test("shows wizard overlay on first boot", async ({ page }) => {
    await page.goto(ADMIN_URL);
    // Wizard overlay should NOT have the hidden class
    const overlay = page.locator("#setup-overlay");
    await expect(overlay).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  });

  test("completes full setup wizard and reveals dashboard", async ({ page }) => {
    await page.goto(ADMIN_URL);

    const overlay = page.locator("#setup-overlay");
    await expect(overlay).not.toHaveClass(/hidden/, { timeout: 10_000 });

    // ── Step 0: Welcome ─────────────────────────────────────────────
    await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // ── Step 1: AI Providers (service instances) — leave blank ──────
    await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // ── Step 2: Security — paste admin token ────────────────────────
    await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
    await page.locator("#wiz-admin").fill(ADMIN_TOKEN);
    await page.getByRole("button", { name: "Next" }).click();

    // ── Step 3: Channels — leave defaults ───────────────────────────
    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // ── Step 4: Access scope — keep default (host) ──────────────────
    await expect(page.getByRole("heading", { name: "Access" })).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // ── Step 5: Health Check — wait for results then finish ─────────
    await expect(page.getByRole("heading", { name: "Health Check" })).toBeVisible({ timeout: 30_000 });
    // Wait until health check results have replaced the "Loading..." placeholder
    await expect(page.locator("#wiz-health")).not.toContainText("Loading", { timeout: 20_000 });
    await page.getByRole("button", { name: "Finish Setup" }).click();

    // ── Step 6: Complete — wait for "Continue to Admin" ─────────────
    await expect(page.getByRole("heading", { name: "Complete" })).toBeVisible();
    // pollUntilReady polls health-check each second for up to 120 s
    await expect(
      page.getByRole("button", { name: "Continue to Admin" })
    ).toBeVisible({ timeout: 130_000 });
    await page.getByRole("button", { name: "Continue to Admin" }).click();

    // ── Post-wizard: dashboard should be visible ────────────────────
    await expect(overlay).toHaveClass(/hidden/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("wizard does not reappear after setup is complete", async ({ page }) => {
    // Setup was completed by the previous test — reload to confirm no wizard
    await page.goto(ADMIN_URL);
    await page.waitForFunction(
      () => (window as any).openPalmSetup !== undefined,
      { timeout: 10_000 }
    );
    // Give the JS a moment to call checkSetup and hide/show the overlay
    await page.waitForTimeout(2000);
    const overlay = page.locator("#setup-overlay");
    await expect(overlay).toHaveClass(/hidden/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});
