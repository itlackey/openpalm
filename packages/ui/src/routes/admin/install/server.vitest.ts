/**
 * Route-level tests for POST /admin/install.
 *
 * Covers the consolidated install flow: the pre-state migration gate
 * (MigrationError → 500), the success response shape, and the docker-unavailable
 * branch. applyInstall now runs the OP_HOME reconcile internally (no compose);
 * the route owns the sole composeUp.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ComposeFn = (args: unknown) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;
const applyInstallMock = vi.fn<() => Promise<void>>();
const ensureMigratedMock = vi.fn();
const composeUpMock = vi.fn<ComposeFn>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const buildManagedServicesMock = vi.fn<() => Promise<string[]>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyInstall: (...args: unknown[]) => applyInstallMock(...(args as [])),
    ensureMigrated: (...args: unknown[]) => ensureMigratedMock(...(args as [])),
    composeUp: (...args: unknown[]) => composeUpMock(...(args as [unknown])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    buildManagedServices: (...args: unknown[]) => buildManagedServicesMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    ensureSecrets: () => undefined,
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
  };
});

import { MigrationError } from '@openpalm/lib';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/install', {
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
  resetState('admin-token');
  applyInstallMock.mockReset();
  ensureMigratedMock.mockReset();
  composeUpMock.mockReset();
  checkDockerMock.mockReset();
  buildManagedServicesMock.mockReset();

  applyInstallMock.mockResolvedValue(undefined);
  ensureMigratedMock.mockReturnValue({ migrated: false, from: 2, to: 2, applied: [], backupDir: null, notes: [] });
  composeUpMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  buildManagedServicesMock.mockResolvedValue(['assistant']);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/install', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 200 with started core services and compose result on success', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      started: string[];
      dockerAvailable: boolean;
      composeResult: { ok: boolean; stderr: string } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.started).toContain('assistant');
    expect(body.started).toContain('guardian');
    expect(body.dockerAvailable).toBe(true);
    expect(body.composeResult).toEqual({ ok: true, stderr: '' });
    // The route owns the sole composeUp (applyInstall no longer composes).
    expect(applyInstallMock).toHaveBeenCalledTimes(1);
    expect(composeUpMock).toHaveBeenCalledTimes(1);
  });

  test('skips composeUp and reports dockerAvailable:false when docker is unavailable', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dockerAvailable: boolean; composeResult: unknown };
    expect(body.dockerAvailable).toBe(false);
    expect(body.composeResult).toBeNull();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  test('returns 500 migration_failed when the pre-state migration gate aborts', async () => {
    ensureMigratedMock.mockImplementation(() => {
      throw new MigrationError('migration blew up', 'do the thing', '/backup/dir');
    });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string; details: { backupDir?: string } };
    expect(body.error).toBe('migration_failed');
    expect(body.message).toBe('migration blew up');
    expect(body.details.backupDir).toBe('/backup/dir');
    // The migration gate runs BEFORE any state/compose work.
    expect(applyInstallMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });
});
