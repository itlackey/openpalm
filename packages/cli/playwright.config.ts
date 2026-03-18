import { defineConfig } from '@playwright/test';

const WIZARD_PORT = 18200;

export default defineConfig({
	testDir: 'e2e',
	webServer: {
		command: `bun run e2e/start-wizard-server.ts ${WIZARD_PORT}`,
		port: WIZARD_PORT,
		stdout: 'pipe',
		reuseExistingServer: !process.env.CI,
	},
	use: {
		baseURL: `http://localhost:${WIZARD_PORT}`,
	},
});
