import { defineConfig } from '@playwright/test';

const STACK_TESTS = process.env.RUN_DOCKER_STACK_TESTS === '1';
const baseURL = STACK_TESTS ? 'http://localhost:8100' : 'http://localhost:4173';

export default defineConfig({
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	reporter: [['list'], ['./e2e/no-skip-reporter.mjs']],
	use: { baseURL },
	webServer: STACK_TESTS ? undefined : { command: 'npm run build && npm run preview', port: 4173 },
	testDir: 'e2e',
	timeout: 60000,
});
