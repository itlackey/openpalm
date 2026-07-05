/**
 * Thin route tests for POST /admin/uninstall (3.4 — mutating-endpoint coverage).
 *
 * Previously untested. Covers: auth gate, the docker-unavailable path (skips
 * compose down but still applies uninstall), the success path, and an
 * applyUninstall failure surfacing as 500.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const composeDownMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const applyUninstallMock = vi.fn<() => Promise<{ stopped: string[] }>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    composeDown: (...args: unknown[]) => composeDownMock(...(args as [])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    applyUninstall: (...args: unknown[]) => applyUninstallMock(...(args as [])),
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/uninstall', {
      method: 'POST',
      headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
      body: '{}',
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  resetState('admin-token');
  composeDownMock.mockReset();
  checkDockerMock.mockReset();
  applyUninstallMock.mockReset();

  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  composeDownMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
  applyUninstallMock.mockResolvedValue({ stopped: ['assistant', 'guardian'] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/uninstall', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('stops containers via compose down then applies uninstall on success', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stopped).toEqual(['assistant', 'guardian']);
    expect(body.dockerAvailable).toBe(true);
    expect(composeDownMock).toHaveBeenCalledOnce();
    expect(applyUninstallMock).toHaveBeenCalledOnce();
  });

  test('skips compose down but still applies uninstall when docker is unavailable', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dockerAvailable).toBe(false);
    expect(composeDownMock).not.toHaveBeenCalled();
    expect(applyUninstallMock).toHaveBeenCalledOnce();
  });

  test('returns 500 uninstall_failed when applyUninstall throws', async () => {
    applyUninstallMock.mockRejectedValue(new Error('disk full'));
    const res = await POST(makePostEvent());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('uninstall_failed');
    expect(body.message).toBe('disk full');
  });
});
