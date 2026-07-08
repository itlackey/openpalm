/**
 * Thin route tests for GET/POST /api/host/unlock (3.4 — mutating-endpoint coverage).
 *
 * Previously untested. GET reports lock status (read-only); POST clears the
 * lock ONLY when stale, returning 409 install_in_progress for a live lock —
 * the route must never blind-remove a lock a running install still holds.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InstallLockStatus, UnlockResult } from '@openpalm/lib';

const inspectInstallLockMock = vi.fn<() => InstallLockStatus>();
const unlockInstallLockMock = vi.fn<() => UnlockResult>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    inspectInstallLock: (...args: unknown[]) => inspectInstallLockMock(...(args as [])),
    unlockInstallLock: (...args: unknown[]) => unlockInstallLockMock(...(args as [])),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { GET, POST } from './+server.js';

function makeEvent(method: 'GET' | 'POST', token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/api/host/unlock', {
      method,
      headers: { cookie: `op_session=${token}` },
    }),
  } as Parameters<typeof GET>[0];
}

const NOT_PRESENT: InstallLockStatus = { present: false, path: '/tmp/.install.lock' };
const STALE: InstallLockStatus = {
  present: true,
  path: '/tmp/.install.lock',
  pid: 12345,
  timestamp: Date.now() - 3_600_000,
  ageMs: 3_600_000,
  stale: true,
};
const LIVE: InstallLockStatus = {
  present: true,
  path: '/tmp/.install.lock',
  pid: 999,
  timestamp: Date.now(),
  ageMs: 1_000,
  stale: false,
};

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_UI_HOST_MODE = 'host-ui';
  resetState('admin-token');
  inspectInstallLockMock.mockReset();
  unlockInstallLockMock.mockReset();
  inspectInstallLockMock.mockReturnValue(NOT_PRESENT);
});

afterEach(() => {
  delete process.env.OP_UI_HOST_MODE;
  vi.clearAllMocks();
});

describe('GET /api/host/unlock', () => {
  test('requires admin auth', async () => {
    const res = await GET(makeEvent('GET', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('reports no lock present', async () => {
    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.present).toBe(false);
  });

  test('reports a stale lock', async () => {
    inspectInstallLockMock.mockReturnValue(STALE);
    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(true);
    expect(body.stale).toBe(true);
  });
});

describe('POST /api/host/unlock', () => {
  test('requires admin auth', async () => {
    const res = await POST(makeEvent('POST', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('clears a stale lock and returns removed:true', async () => {
    unlockInstallLockMock.mockReturnValue({ ok: true, removed: true, status: STALE });
    const res = await POST(makeEvent('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
  });

  test('is idempotent when no lock is present (removed:false)', async () => {
    unlockInstallLockMock.mockReturnValue({ ok: true, removed: false, status: NOT_PRESENT });
    const res = await POST(makeEvent('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(false);
  });

  test('returns 409 install_in_progress and does NOT remove a live lock', async () => {
    unlockInstallLockMock.mockReturnValue({ ok: false, reason: 'live', status: LIVE });
    const res = await POST(makeEvent('POST'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('install_in_progress');
  });
});
