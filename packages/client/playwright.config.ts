import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * G2 [HIGH] (review 2026-07-10 §G2) — the client had zero browser/e2e
 * coverage; every regression in the migration review shipped without a
 * test able to catch it. This wires a Playwright project against a real
 * production build served by bin/serve.mjs (the H2 fix's own server —
 * exercising it here is a bonus regression check for that fix too), on a
 * port offset from every platform default (3880/3890/etc.) so this suite
 * never collides with a developer's running dev stack.
 *
 * Every spec drives the client against a stub assistant
 * (e2e/fixtures/stub-assistant.ts) — no docker, no live OpenCode/guardian.
 */
const PORT = Number(process.env.CLIENT_E2E_PORT ?? 4319);
const baseURL = `http://127.0.0.1:${PORT}`;

// Some sandboxes pin a pre-fetched Chromium at this exact path without the
// separate headless-shell binary this @playwright/test version defaults to
// for headless runs (PLAYWRIGHT_BROWSERS_PATH alone isn't enough there).
// A real CI runner that ran `playwright install --with-deps chromium`
// won't have this literal path, so this stays a no-op there and normal
// discovery (which DOES find the matching headless-shell binary) applies.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const browserExecutablePath = process.env.OP_PLAYWRIGHT_EXECUTABLE_PATH?.trim()
  || (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.pw.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node bin/serve.mjs --port ${PORT} --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: browserExecutablePath ? { executablePath: browserExecutablePath } : undefined,
        // The copy affordance uses the async clipboard API, which headless
        // chromium on CI runners denies without an explicit grant (locally
        // some sandboxes auto-grant, which is why this only failed in CI).
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
});
