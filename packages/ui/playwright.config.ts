import { defineConfig } from '@playwright/test';

const STACK_TESTS = process.env.RUN_DOCKER_STACK_TESTS === '1';
// v0.11.0: admin is a host process (default port 3880, overridable via OP_HOST_UI_PORT)
const ADMIN_PORT = process.env.OP_HOST_UI_PORT ?? '3880';
// Use 127.0.0.1 for stack tests — services bind to 127.0.0.1 (IPv4 only),
// and `localhost` may resolve to ::1 first → ECONNREFUSED.
const baseURL = STACK_TESTS ? `http://127.0.0.1:${ADMIN_PORT}` : 'http://localhost:4173';

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
