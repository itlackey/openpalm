/**
 * Route-level tests for POST /admin/install.
 *
 * Phase 3: the route is now a thin wrapper over applyInstall() (files) +
 * applyStack() (containers). Pull failure is FATAL (§6). These tests verify
 * the correct response shape at the route boundary.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ApplyStackFn = (scope: unknown, opts: unknown) => Promise<{
  ok: boolean;
  started: string[];
  failed: { service: string; reason: string }[];
  error?: string;
}>;
const applyInstallMock = vi.fn<() => Promise<void>>();
const applyStackMock = vi.fn<ApplyStackFn>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyInstall: (...args: unknown[]) => applyInstallMock(...(args as [])),
    applyStack: (...args: unknown[]) => applyStackMock(...(args as [unknown, unknown])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    ensureSecrets: () => undefined,
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [], profiles: [] }),
  };
});

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
  applyStackMock.mockReset();
  checkDockerMock.mockReset();

  applyInstallMock.mockResolvedValue(undefined);
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  applyStackMock.mockResolvedValue({ ok: true, started: ['assistant', 'guardian'], failed: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/install', () => {
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
  });
});
