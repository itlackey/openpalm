import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STACK_TESTS = process.env.RUN_DOCKER_STACK_TESTS === '1';
// Use ADMIN_URL if set (populated by global-setup from stack.env), or fall back to
// the test-isolated port 9100 — offset from the default dev stack (8100) to prevent
// tests from accidentally hitting a developer's running stack.
const baseURL = STACK_TESTS
  ? (process.env.ADMIN_URL ?? 'http://127.0.0.1:9100')
  : 'http://localhost:4173';

// The self-contained *.pw.ts suite runs the built preview server against a
// throwaway OP_HOME (never a developer's `.dev` or `~/.openpalm`) with a
// known login password and OP_ENABLE_ADMIN=1 so /admin/* is reachable. No
// docker, no compose files, no live stack — every route under test either
// never reaches the docker layer (auth checks run first) or degrades
// gracefully when docker/compose files are absent (see containers/list,
// hooks.server.ts's launch-routing probe).
const MOCKED_OP_HOME = STACK_TESTS ? undefined : mkdtempSync(join(tmpdir(), 'openpalm-pw-'));
const MOCKED_ENV = STACK_TESTS
  ? undefined
  : {
      OP_HOME: MOCKED_OP_HOME as string,
      OP_ENABLE_ADMIN: '1',
      OP_UI_LOGIN_PASSWORD: 'e2e-mocked-password',
    };

export default defineConfig({
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	reporter: [['list'], ['./e2e/no-skip-reporter.mjs']],
	use: { baseURL },
	webServer: STACK_TESTS
		? undefined
		: { command: 'npm run build && npm run preview', port: 4173, env: MOCKED_ENV },
	testDir: 'e2e',
	testMatch: STACK_TESTS ? ['*.pw.ts', '*.stack.ts'] : '*.pw.ts',
	timeout: 60000,
});
