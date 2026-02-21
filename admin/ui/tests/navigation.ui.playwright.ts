import { expect, test } from "@playwright/test";

const ADMIN_TOKEN = "dev-admin-token";
const AUTH_HEADERS = { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" };
const ADMIN_API = "http://localhost/admin/api";
const ADMIN_URL = "http://localhost/admin/";

test.describe("Admin UI Navigation", () => {
  // Ensure setup is complete before any navigation test runs.
  // This makes the suite self-sufficient — it can run standalone or after
  // the setup-wizard suite.
  test.beforeAll(async ({ request }) => {
    const resp = await request.get(`${ADMIN_API}/setup/status`, {
      headers: AUTH_HEADERS,
    });
    const body = await resp.json();
    if (!body.completed) {
      // Complete all wizard steps programmatically via API
      await request.post(`${ADMIN_API}/setup/step`, {
        data: { step: "welcome" },
        headers: AUTH_HEADERS,
      });
      await request.post(`${ADMIN_API}/setup/step`, {
        data: { step: "serviceInstances" },
        headers: AUTH_HEADERS,
      });
      await request.post(`${ADMIN_API}/setup/step`, {
        data: { step: "security" },
        headers: AUTH_HEADERS,
      });
      await request.post(`${ADMIN_API}/setup/step`, {
        data: { step: "channels" },
        headers: AUTH_HEADERS,
      });
      await request.post(`${ADMIN_API}/setup/access-scope`, {
        data: { scope: "host" },
        headers: AUTH_HEADERS,
      });
      await request.post(`${ADMIN_API}/setup/step`, {
        data: { step: "healthCheck" },
        headers: AUTH_HEADERS,
      });
      await request.post(`${ADMIN_API}/setup/complete`, { headers: AUTH_HEADERS });
    }
  });

  test("dashboard loads and wizard is hidden", async ({ page }) => {
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
      timeout: 10_000,
    });
    // Wizard overlay must not be visible after setup is complete
    const overlay = page.locator("#setup-overlay");
    await page.waitForTimeout(1500);
    await expect(overlay).toHaveClass(/hidden/);
  });

  test("dashboard shows OpenCode and OpenMemory links", async ({ page }) => {
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("link", { name: /Open OpenCode/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Open Memory Dashboard/i })
    ).toBeVisible();
  });

  test("OpenCode UI responds with 200", async ({ request }) => {
    const resp = await request.get("http://localhost/admin/opencode/");
    expect(resp.status()).toBe(200);
  });

  test("OpenCode UI loads the app UI", async ({ page }) => {
    await page.goto("http://localhost/admin/opencode/");
    // OpenCode is an SPA — verify it boots by checking the page title and
    // the always-present sidebar toggle button.
    await expect(page).toHaveTitle(/opencode/i, { timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Toggle sidebar" })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("OpenMemory UI loads at port 3000", async ({ page }) => {
    await page.goto("http://localhost:3000/");
    await expect(page.getByText("OpenMemory")).toBeVisible({ timeout: 10_000 });
  });

  test("admin health API returns ok", async ({ request }) => {
    const resp = await request.get("http://localhost:8100/health");
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("admin");
  });

  test("admin health check reports all core services healthy", async ({
    request,
  }) => {
    const resp = await request.get(`${ADMIN_API}/setup/health-check`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.services.gateway?.ok).toBe(true);
    expect(body.services.assistant?.ok).toBe(true);
    expect(body.services.openmemory?.ok).toBe(true);
    expect(body.services.admin?.ok).toBe(true);
  });
});
