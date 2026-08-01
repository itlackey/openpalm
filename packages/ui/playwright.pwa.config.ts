import { chromium, defineConfig } from '@playwright/test';
import { resolveChromiumLaunchTarget } from './e2e/pwa/chromium-launch-target.js';

const uiPort = process.env.OP_PWA_UI_PORT ?? '4174';
const baseURL = `http://localhost:${uiPort}`;
const chromiumLaunchTarget = resolveChromiumLaunchTarget(
  process.env.OP_PLAYWRIGHT_EXECUTABLE_PATH,
  chromium.executablePath(),
);

export default defineConfig({
  reporter: 'list',
  workers: 1,
  testDir: 'e2e/pwa',
  testMatch: '*.pwa.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { baseURL, launchOptions: chromiumLaunchTarget },
  webServer: {
    command: 'node e2e/pwa/test-server.mjs',
    url: `${baseURL}/manifest.webmanifest`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
