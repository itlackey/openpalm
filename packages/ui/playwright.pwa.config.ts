import { defineConfig } from '@playwright/test';

const uiPort = process.env.OP_PWA_UI_PORT ?? '4174';
const baseURL = `http://localhost:${uiPort}`;

export default defineConfig({
  reporter: 'list',
  workers: 1,
  testDir: 'e2e/pwa',
  testMatch: '*.pwa.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { baseURL },
  webServer: {
    command: 'node e2e/pwa/test-server.mjs',
    url: `${baseURL}/manifest.webmanifest`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
