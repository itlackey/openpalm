/**
 * Route-level tests for POST /api/host/install.
 *
 * Phase 3: the route is now a thin wrapper over applyInstall() (files) +
 * applyStack() (containers). Pull failure is FATAL (§6). These tests verify
 * the correct response shape at the route boundary.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type ApplyStackFn = (scope: unknown, opts: unknown) => Promise<{
  ok: boolean;
  started: string[];
  failed: { service: string; reason: string }[];
  error?: string;
}>;
const applyInstallMock = vi.fn<() => Promise<void>>();
const applyStackMock = vi.fn<ApplyStackFn>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const restoreSnapshotAndApplyStackMock = vi.fn<() => Promise<void>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyInstall: (...args: unknown[]) => applyInstallMock(...(args as [])),
    applyStack: (...args: unknown[]) => applyStackMock(...(args as [unknown, unknown])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    restoreSnapshot: vi.fn(),
    restoreSnapshotAndApplyStack: (...args: unknown[]) => restoreSnapshotAndApplyStackMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    ensureSecrets: () => undefined,
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [], profiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/api/host/install', {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-install-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  resetState('admin-token');
  applyInstallMock.mockReset();
  applyStackMock.mockReset();
  checkDockerMock.mockReset();
  restoreSnapshotAndApplyStackMock.mockReset();

  applyInstallMock.mockResolvedValue(undefined);
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  applyStackMock.mockResolvedValue({ ok: true, started: ['assistant', 'guardian'], failed: [] });
  restoreSnapshotAndApplyStackMock.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  vi.clearAllMocks();
  // The lock-contention test writes a foreign-held .install.lock into the
  // (test-shared) dataDir; remove it so it can't wedge later tests.
  rmSync(join(getState().dataDir, '.install.lock'), { force: true });
});

describe('POST /api/host/install', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 200 with started services when applyStack succeeds', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      started: string[];
      failed: { service: string; reason: string }[];
      dockerAvailable: boolean;
      overallSuccess: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.overallSuccess).toBe(true);
    expect(body.started).toContain('assistant');
    expect(body.dockerAvailable).toBe(true);
    expect(body.failed).toEqual([]);
    // applyInstall and applyStack each called once
    expect(applyInstallMock).toHaveBeenCalledTimes(1);
    expect(applyStackMock).toHaveBeenCalledTimes(1);
  });

  test('skips applyStack and returns dockerAvailable:false when docker is unavailable', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dockerAvailable: boolean;
      started: string[];
      ok: boolean;
    };
    expect(body.dockerAvailable).toBe(false);
    expect(body.started).toEqual([]);
    // applyStack must NOT have been called when docker is unavailable
    expect(applyStackMock).not.toHaveBeenCalled();
  });

  test('returns install_in_progress and skips applyStack when the install lock is held', async () => {
    // A concurrent install (e.g. a CLI deploy or another process) holds the
    // lock across its whole applyInstall + applyStack phase. PID 1 is always
    // alive but foreign, so acquireInstallLock returns null here.
    const dataDir = getState().dataDir;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, '.install.lock'), `1\n${Date.now()}\n`);

    const res = await POST(makePostEvent());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('install_in_progress');
    // Neither the file apply nor the container apply may run under contention.
    expect(applyInstallMock).not.toHaveBeenCalled();
    expect(applyStackMock).not.toHaveBeenCalled();
  });

  test('returns 502 when applyStack fails (pull failure is fatal)', async () => {
    applyStackMock.mockResolvedValue({
      ok: false,
      started: [],
      failed: [{ service: 'stack', reason: 'manifest unknown for openpalm/assistant:bad-tag' }],
      error: 'manifest unknown for openpalm/assistant:bad-tag',
    });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      failed: { service: string; reason: string }[];
      overallSuccess: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.overallSuccess).toBe(false);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].reason).toMatch(/manifest unknown/);
    expect(restoreSnapshotAndApplyStackMock).toHaveBeenCalledTimes(1);
  });
});
