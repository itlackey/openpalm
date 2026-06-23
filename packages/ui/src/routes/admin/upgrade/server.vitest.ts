/**
 * Route-level tests for POST /admin/upgrade.
 *
 * Covers: auth, the pre-state migration gate (MigrationError → 500),
 * docker-unavailable → 503, performUpgrade success response shape (200), and
 * performUpgrade failure → 502. performUpgrade owns the full reconcile + pull +
 * recreate internally (the route does no compose of its own).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const performUpgradeMock = vi.fn();
const ensureMigratedMock = vi.fn();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    performUpgrade: (...args: unknown[]) => performUpgradeMock(...(args as [])),
    ensureMigrated: (...args: unknown[]) => ensureMigratedMock(...(args as [])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    ensureSecrets: () => undefined,
  };
});

import { MigrationError } from '@openpalm/lib';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/upgrade', {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-upgrade-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  resetState('admin-token');
  performUpgradeMock.mockReset();
  ensureMigratedMock.mockReset();
  checkDockerMock.mockReset();

  ensureMigratedMock.mockReturnValue({ migrated: false, from: 2, to: 2, applied: [], backupDir: null, notes: [] });
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  performUpgradeMock.mockResolvedValue({
    imageTag: 'v9.9.9',
    namespace: 'openpalm',
    backupDir: '/op/data/backups/2026-06-23-release',
    assetsUpdated: ['config/stack/core.compose.yml', 'config/stack/services.compose.yml'],
    restarted: ['assistant'],
    warnings: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/upgrade', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 200 with the UpgradeResult shape on success', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      imageTag: string;
      backupDir: string | null;
      assetsUpdated: string[];
      restarted: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.imageTag).toBe('v9.9.9');
    // The route must surface the backupDir + assetsUpdated that performUpgrade
    // now populates from reconcileHome (release-migration backup + refreshed
    // managed assets), not the empty placeholders it briefly returned.
    expect(body.backupDir).toBe('/op/data/backups/2026-06-23-release');
    expect(body.assetsUpdated).toEqual([
      'config/stack/core.compose.yml',
      'config/stack/services.compose.yml',
    ]);
    expect(body.restarted).toEqual(['assistant']);
    expect(performUpgradeMock).toHaveBeenCalledTimes(1);
  });

  test('returns 503 docker_unavailable when docker is down (no upgrade attempted)', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'no docker', code: 1 });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('docker_unavailable');
    expect(performUpgradeMock).not.toHaveBeenCalled();
  });

  test('returns 500 migration_failed when the pre-state migration gate aborts', async () => {
    ensureMigratedMock.mockImplementation(() => {
      throw new MigrationError('cannot migrate', 'guidance here', '/backup/x');
    });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; details: { backupDir?: string } };
    expect(body.error).toBe('migration_failed');
    expect(body.details.backupDir).toBe('/backup/x');
    expect(performUpgradeMock).not.toHaveBeenCalled();
  });

  test('returns 502 upgrade_failed when performUpgrade throws', async () => {
    performUpgradeMock.mockRejectedValue(new Error('Failed to pull images: boom'));

    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('upgrade_failed');
    expect(body.message).toMatch(/Failed to pull images/);
  });
});
