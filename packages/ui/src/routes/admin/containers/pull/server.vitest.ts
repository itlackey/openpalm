/**
 * Thin route tests for POST /admin/containers/pull (3.4 — mutating-endpoint coverage).
 *
 * Previously untested. Covers: auth gate, docker-unavailable 503, pull
 * failure (502), compose-up-after-pull failure (502), and the success path
 * (force-recreate against the managed-services set).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const composePullMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const composeUpMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const buildManagedServicesMock = vi.fn<() => Promise<string[]>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    composePull: (...args: unknown[]) => composePullMock(...(args as [])),
    composeUp: (...args: unknown[]) => composeUpMock(...(args as [])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    buildManagedServices: (...args: unknown[]) => buildManagedServicesMock(...(args as [])),
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/containers/pull', {
      method: 'POST',
      headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
      body: '{}',
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  resetState('admin-token');
  composePullMock.mockReset();
  composeUpMock.mockReset();
  checkDockerMock.mockReset();
  buildManagedServicesMock.mockReset();

  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  composePullMock.mockResolvedValue({ ok: true, stdout: 'pulled', stderr: '', code: 0 });
  composeUpMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
  buildManagedServicesMock.mockResolvedValue(['assistant', 'guardian']);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/containers/pull', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 503 docker_unavailable when docker is down', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('docker_unavailable');
    expect(composePullMock).not.toHaveBeenCalled();
  });

  test('returns 502 pull_failed when the image pull fails', async () => {
    composePullMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'pull access denied', code: 1 });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('pull_failed');
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  test('returns 502 up_failed when recreate fails after a successful pull', async () => {
    composeUpMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'no such service', code: 1 });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('up_failed');
  });

  test('force-recreates every managed service on success', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.started).toEqual(['assistant', 'guardian']);
    expect(composeUpMock).toHaveBeenCalledWith(
      expect.objectContaining({ services: ['assistant', 'guardian'], forceRecreate: true }),
    );
  });
});
