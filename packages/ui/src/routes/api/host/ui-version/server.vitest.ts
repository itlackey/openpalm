import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const checkAndUpdateUiBuildMock = vi.fn();
const recordPendingUiBackupMock = vi.fn();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    checkAndUpdateUiBuild: (...args: unknown[]) => checkAndUpdateUiBuildMock(...args),
    recordPendingUiBackup: (...args: unknown[]) => recordPendingUiBackupMock(...args),
  };
});

import { PLATFORM_VERSION } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function event(): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/api/host/ui-version', {
      method: 'POST',
      headers: {
        cookie: 'op_session=admin-token',
        'content-type': 'application/json',
        'x-request-id': 'req-ui-update',
      },
      body: '{}',
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  process.env.OP_UI_HOST_MODE = 'host-ui';
  process.env.OP_UI_SUPERVISOR = 'electron';
  process.env.OP_HARNESS_CONTRACT_VERSION = '2';
  resetState('admin-token');
  checkAndUpdateUiBuildMock.mockReset();
  recordPendingUiBackupMock.mockReset();
  mkdirSync(join(getState().homeDir, 'state'), { recursive: true });
  writeFileSync(join(getState().homeDir, 'state', 'stack.state.env'), 'OP_UI_CHANNEL=next\n');
});

afterEach(() => {
  delete process.env.OP_UI_HOST_MODE;
  delete process.env.OP_UI_SUPERVISOR;
  delete process.env.OP_HARNESS_CONTRACT_VERSION;
  vi.clearAllMocks();
});

describe('POST /api/host/ui-version', () => {
  test('uses the selected channel, backed-up updater, and Electron harness contract', async () => {
    checkAndUpdateUiBuildMock.mockResolvedValue({
      updated: true,
      latestVersion: '0.13.0-beta.9',
      backupDir: '/tmp/ui-backup',
    });

    const response = await POST(event());
    expect(response.status).toBe(200);
    expect(checkAndUpdateUiBuildMock).toHaveBeenCalledWith(
      PLATFORM_VERSION,
      getState().dataDir,
      'next',
      2,
    );
    expect(await response.json()).toMatchObject({
      updated: true,
      pendingRestart: true,
      redownloadRequired: false,
    });
    expect(recordPendingUiBackupMock).toHaveBeenCalledWith(getState().dataDir, '/tmp/ui-backup');
  });

  test('reports redownloadRequired without installing or restarting an incompatible build', async () => {
    checkAndUpdateUiBuildMock.mockResolvedValue({
      updated: false,
      latestVersion: '0.13.0-beta.10',
      redownloadRequired: true,
      requiredHarnessContract: 3,
    });

    const response = await POST(event());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      updated: false,
      restarting: false,
      pendingRestart: false,
      redownloadRequired: true,
      requiredHarnessContract: 3,
    });
  });

  test('fails closed when Electron omits a valid harness contract', async () => {
    delete process.env.OP_HARNESS_CONTRACT_VERSION;

    const response = await POST(event());
    expect(response.status).toBe(500);
    expect(checkAndUpdateUiBuildMock).not.toHaveBeenCalled();
  });
});
