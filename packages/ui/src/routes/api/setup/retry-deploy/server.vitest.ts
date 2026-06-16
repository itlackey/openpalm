import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

// ── Hoisted mocks (must be declared before vi.mock factories run) ────────────

const { performSetupMock, startDeployMock } = vi.hoisted(() => ({
  performSetupMock: vi.fn(),
  startDeployMock: vi.fn(),
}));

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    checkDocker: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
    performSetup: performSetupMock,
  };
});

vi.mock('$lib/server/setup-deploy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/server/setup-deploy.js')>();
  return {
    ...original,
    startDeploy: startDeployMock,
    getDeployState: vi.fn(() => ({
      deploying: false,
      setupComplete: false,
      deployStatus: [],
      deployError: null,
      imageWarning: null,
      phase: 'writing-config',
    })),
  };
});

import { POST } from './+server.js';

// ── Temp home ───────────────────────────────────────────────────────────────

let rootDir = '';
let originalOpHome: string | undefined;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpalm-retry-deploy-'));
  originalOpHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  process.env.PORT = '3880';
  resetState('retry-pw');
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalOpHome !== undefined) {
    process.env.OP_HOME = originalOpHome;
  } else {
    delete process.env.OP_HOME;
  }
  rmSync(rootDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/setup/retry-deploy', () => {
  test('refuses once setup is complete', async () => {
    const state = resetState('pw');
    const envDir = join(state.stackDir, '..', '..', 'knowledge', 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');

    const response = await POST({} as never);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe('setup_complete');
  });

  test('knowledge/secrets/ and akm config mtimes are unchanged — performSetup is never called', async () => {
    // Seed knowledge/secrets/ and a mock akm config file.
    const secretsDir = join(rootDir, 'knowledge', 'secrets');
    const akmConfigDir = join(rootDir, 'config', 'akm');
    mkdirSync(secretsDir, { recursive: true });
    mkdirSync(akmConfigDir, { recursive: true });

    const secretFile = join(secretsDir, 'login_password');
    const akmConfigFile = join(akmConfigDir, 'config.json');
    writeFileSync(secretFile, 'hunter2', { mode: 0o600 });
    writeFileSync(akmConfigFile, '{}', { mode: 0o600 });

    // Capture mtimes before the POST.
    const secretMtimeBefore = statSync(secretFile).mtimeMs;
    const akmConfigMtimeBefore = statSync(akmConfigFile).mtimeMs;

    // POST the route — startDeploy is mocked so no Docker calls happen.
    const response = await POST({} as never);
    expect(response.status).toBe(200);

    const secretMtimeAfter = statSync(secretFile).mtimeMs;
    const akmConfigMtimeAfter = statSync(akmConfigFile).mtimeMs;

    // Mtimes must be unchanged — the route only kicks off the deploy spine.
    expect(secretMtimeAfter).toBe(secretMtimeBefore);
    expect(akmConfigMtimeAfter).toBe(akmConfigMtimeBefore);

    // performSetup must never have been called.
    expect(performSetupMock).not.toHaveBeenCalled();

    // startDeploy (the deploy spine) must have been called exactly once.
    expect(startDeployMock).toHaveBeenCalledTimes(1);
  });
});
