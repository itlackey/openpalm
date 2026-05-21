import { defineConfig } from '@playwright/test';

const STACK_TESTS = process.env.RUN_DOCKER_STACK_TESTS === '1';
// Use ADMIN_URL if set (populated by global-setup from stack.env), or fall back to
// the test-isolated port 9100 — offset from the default dev stack (8100) to prevent
// tests from accidentally hitting a developer's running stack.
const baseURL = STACK_TESTS
  ? (process.env.ADMIN_URL ?? 'http://127.0.0.1:9100')
  : 'http://localhost:4173';

export default defineConfig({
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	reporter: [['list'], ['./e2e/no-skip-reporter.mjs']],
	use: { baseURL },
	webServer: STACK_TESTS ? undefined : { command: 'npm run build && npm run preview', port: 4173 },
	testDir: 'e2e',
	testMatch: '*.pw.ts',
	timeout: 60000,
});
