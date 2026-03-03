import { defineConfig } from '@playwright/test';

export default defineConfig({
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	webServer: { command: 'npm run build && npm run preview', port: 4173 },
	testDir: 'e2e'
});
