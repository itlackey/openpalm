import { defineConfig } from '@playwright/test';
import { PORT, webServerEnv } from './e2e/env';

const BASE = `http://localhost:${PORT}`;

export default defineConfig({
	globalTeardown: './e2e/global-teardown.ts',
	testDir: 'e2e',
	testMatch: '**/*.pw.ts',
	workers: 1,
	fullyParallel: false,
	timeout: 30_000,
	expect: { timeout: 5_000 },
	use: {
		baseURL: BASE
	},
	webServer: {
		command: `bun run build && node build/index.js`,
		port: PORT,
		timeout: 60_000,
		reuseExistingServer: false,
		env: webServerEnv()
	}
});
