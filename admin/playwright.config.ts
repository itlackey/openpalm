import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./ui/tests",
  testMatch: "**/*.ui.playwright.ts",
  // Global setup resets the admin state file before each test run
  globalSetup: "./ui/tests/global-setup.ts",
  // Run suites sequentially so wizard test and navigation test don't race
  // over shared setup-state.json
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost/admin",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Default per-test timeout. The wizard suite overrides this to 180 s.
  timeout: 30_000,
});
