import { defineConfig } from '@playwright/test';

export default defineConfig({
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	reporter: [['list'], ['./e2e/no-skip-reporter.mjs']],
	webServer: { command: 'npm run build && npm run preview', port: 4173 },
	testDir: 'e2e',
	timeout: 60000,
});
