import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { resolveDeployJournalPath, writeJournal } from '@openpalm/lib';

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
  };
});

import { POST } from './+server.js';

// getRequestId(event) (W15 error envelope) reads event.request.headers — a
// bare `{}` throws before the route logic runs, so every call needs a real
// Request even though these tests don't care about its URL/headers.
function fakeEvent(): Parameters<typeof POST>[0] {
  return { request: new Request('http://127.0.0.1/api/setup/retry-deploy') } as Parameters<typeof POST>[0];
}

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
    const stateDir = join(state.homeDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');

    const response = await POST(fakeEvent());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe('setup_complete');
    expect(startDeployMock).not.toHaveBeenCalled();
  });

  test('allows a setup-complete rerun to retry its persisted failed deploy', async () => {
    const state = resetState('pw');
    const stateDir = join(state.homeDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
    writeJournal(resolveDeployJournalPath(state), {
      deploying: false,
      setupComplete: true,
      deployStatus: [{ service: 'assistant', status: 'error', label: 'Did not start' }],
      deployError: 'Stack update failed.',
      imageWarning: null,
      phase: 'starting',
      startedAt: null,
      pid: null,
    });

    const response = await POST(fakeEvent());

    expect(response.status).toBe(200);
    expect(startDeployMock).toHaveBeenCalledWith(state);
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
    const response = await POST(fakeEvent());
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
