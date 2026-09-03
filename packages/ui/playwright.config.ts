import { defineConfig } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STACK_TESTS = process.env.RUN_DOCKER_STACK_TESTS === '1';
const browserExecutablePath = process.env.OP_PLAYWRIGHT_EXECUTABLE_PATH?.trim();
// Use ADMIN_URL if set (populated by global-setup from stack.env), or fall back to
// the test-isolated port 9100 — offset from the default dev stack (8100) to prevent
// tests from accidentally hitting a developer's running stack.
const baseURL = STACK_TESTS
  ? (process.env.ADMIN_URL ?? 'http://127.0.0.1:9100')
  : 'http://localhost:4173';

// The self-contained *.pw.ts suite runs the built preview server against a
// setup-complete throwaway OP_HOME (never a developer's `.dev` or
// `~/.openpalm`) with a known login password and OP_ENABLE_ADMIN=1 so /host
// (and /api/host/*) is reachable in admin mode. No
// docker, no compose files, no live stack — every route under test either
// never reaches the docker layer (auth checks run first) or degrades
// gracefully when docker/compose files are absent (see containers/list,
// hooks.server.ts's launch-routing probe).
const MOCKED_OP_HOME = STACK_TESTS ? undefined : mkdtempSync(join(tmpdir(), 'openpalm-pw-'));
if (MOCKED_OP_HOME) {
  mkdirSync(join(MOCKED_OP_HOME, 'state'), { recursive: true });
  writeFileSync(join(MOCKED_OP_HOME, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
}
const MOCKED_ENV = STACK_TESTS
  ? undefined
  : {
      OP_HOME: MOCKED_OP_HOME as string,
      OP_ENABLE_ADMIN: '1',
      OP_UI_LOGIN_PASSWORD: 'e2e-mocked-password',
    };

const STACK_PROJECTS = [
  {
    name: 'stack-baseline',
    testMatch: ['*.stack.ts', 'auth-flow.pw.ts'],
    testIgnore: [
      'install-flow.stack.ts',
      'lan-access.stack.ts',
      'setup-wizard-api.stack.ts',
      'setup-wizard-browser.stack.ts',
      'setup-wizard-recovery.stack.ts',
    ],
  },
  {
    name: 'stack-lan',
    testMatch: 'lan-access.stack.ts',
    dependencies: ['stack-baseline'],
  },
  {
    name: 'stack-wizard',
    testMatch: [
      'install-flow.stack.ts',
      'setup-wizard-api.stack.ts',
      'setup-wizard-browser.stack.ts',
      // #678. Runs with the wizard group because it resets wizard state; the
      // baseline group expects a completed setup.
      'setup-wizard-recovery.stack.ts',
    ],
    dependencies: ['stack-lan'],
  },
];

export default defineConfig({
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	reporter: [['list'], ['./e2e/no-skip-reporter.mjs']],
	workers: STACK_TESTS ? 1 : undefined,
	projects: STACK_TESTS ? STACK_PROJECTS : undefined,
	use: {
		baseURL,
		launchOptions: browserExecutablePath ? { executablePath: browserExecutablePath } : undefined,
	},
	webServer: STACK_TESTS
		? undefined
		: { command: 'npm run build && npm run preview', port: 4173, env: MOCKED_ENV },
	testDir: 'e2e',
	testMatch: STACK_TESTS ? undefined : '*.pw.ts',
	timeout: 60000,
});
