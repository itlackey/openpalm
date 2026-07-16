/**
 * Thin route tests for POST /api/host/containers/pull (3.4 — mutating-endpoint coverage).
 *
 * Covers: auth gate, docker-unavailable 503, applyStack failure (502), and the
 * success path — the button routes through the single compose driver applyStack
 * with `pull: "always"` (force a fresh pull even on an unchanged tag).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ApplyStackResult = {
  ok: boolean;
  started: string[];
  failed: { service: string; reason: string }[];
  error?: string;
  rawStderr?: string;
};

const applyStackMock = vi.fn<() => Promise<ApplyStackResult>>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const buildManagedServicesMock = vi.fn<() => Promise<string[]>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyStack: (...args: unknown[]) => applyStackMock(...(args as [])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    buildManagedServices: (...args: unknown[]) => buildManagedServicesMock(...(args as [])),
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/api/host/containers/pull', {
      method: 'POST',
      headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
      body: '{}',
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  resetState('admin-token');
  applyStackMock.mockReset();
  checkDockerMock.mockReset();
  buildManagedServicesMock.mockReset();

  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  applyStackMock.mockResolvedValue({ ok: true, started: ['assistant', 'guardian'], failed: [] });
  buildManagedServicesMock.mockResolvedValue(['assistant', 'guardian']);
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  vi.clearAllMocks();
});

describe('POST /api/host/containers/pull', () => {
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
    expect(applyStackMock).not.toHaveBeenCalled();
  });

  test('returns 502 up_failed when applyStack (pull + recreate) fails', async () => {
    applyStackMock.mockResolvedValue({ ok: false, started: [], failed: [{ service: 'assistant', reason: 'pull access denied' }], error: 'pull access denied', rawStderr: 'pull access denied' });
    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('up_failed');
  });

  test('force-pulls and recreates every managed service on success', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.started).toEqual(['assistant', 'guardian']);
    // The single compose driver, scoped to the managed set, with pull: 'always'
    // (the button's whole purpose: force a fresh same-tag pull).
    expect(applyStackMock).toHaveBeenCalledWith(
      { kind: 'services', services: ['assistant', 'guardian'] },
      expect.anything(),
      undefined,
      { pull: 'always' },
    );
  });
});
