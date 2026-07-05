/**
 * Thin route tests for POST /admin/containers/down (3.4 — mutating-endpoint coverage).
 *
 * Previously untested. Covers: auth gate, invalid service rejection, the
 * docker-unavailable soft-success path, the docker-success path, and a
 * docker error surfacing as 500.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const composeStopMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    composeStop: (...args: unknown[]) => composeStopMock(...(args as [])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token', body: unknown = { service: 'assistant' }): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/containers/down', {
      method: 'POST',
      headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  resetState('admin-token');
  composeStopMock.mockReset();
  checkDockerMock.mockReset();

  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  composeStopMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/containers/down', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('rejects a service not in the allowlist', async () => {
    const res = await POST(makePostEvent('admin-token', { service: 'not-a-real-service' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_service');
  });

  test('stops the service and returns stopped status when docker succeeds', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('assistant');
    expect(body.status).toBe('stopped');
    expect(composeStopMock).toHaveBeenCalledOnce();
  });

  test('soft-succeeds (optimistic state) when docker is unavailable', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('stopped');
    expect(composeStopMock).not.toHaveBeenCalled();
  });

  test('returns 500 docker_error when compose stop fails', async () => {
    composeStopMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'no such service', code: 1 });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('docker_error');
  });
});
