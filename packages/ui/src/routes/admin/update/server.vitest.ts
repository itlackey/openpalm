/**
 * Route-level tests for POST /admin/update.
 *
 * Phase 3: the route is now a thin wrapper over applyUpdate() (files) +
 * applyStack() (containers). Pull failure is FATAL (§6) — no "restarted
 * from local cache" fallthrough. These tests verify the correct behaviour
 * at the route boundary.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock @openpalm/lib BEFORE importing the route.
type ApplyStackFn = (scope: unknown, opts: unknown) => Promise<{
  ok: boolean;
  started: string[];
  failed: { service: string; reason: string }[];
  error?: string;
}>;
const applyStackMock = vi.fn<ApplyStackFn>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const applyUpdateMock = vi.fn<() => Promise<{ restarted: string[] }>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyUpdate: (...args: unknown[]) => applyUpdateMock(...(args as [])),
    applyStack: (...args: unknown[]) => applyStackMock(...(args as [unknown, unknown])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [], profiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/update', {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-update-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  resetState('admin-token');
  applyStackMock.mockReset();
  checkDockerMock.mockReset();
  applyUpdateMock.mockReset();

  applyUpdateMock.mockResolvedValue({ restarted: [] });
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  // Default: stack comes up cleanly
  applyStackMock.mockResolvedValue({ ok: true, started: ['assistant', 'guardian', 'voice'], failed: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/update', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 200 with all services when applyStack succeeds', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      restarted: string[];
      failed: { service: string; reason: string }[];
      overallSuccess: boolean;
      dockerAvailable: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.overallSuccess).toBe(true);
    expect(body.restarted.sort()).toEqual(['assistant', 'guardian', 'voice']);
    expect(body.failed).toEqual([]);
    expect(body.dockerAvailable).toBe(true);
  });

  test('returns 502 with structured failed[] when pull is denied for one service (fatal)', async () => {
    // In Phase 3, a pull failure is FATAL — applyStack returns ok:false immediately
    // with the failure attributed to the failing image/service (no partial success).
    applyStackMock.mockResolvedValue({
      ok: false,
      started: [],
      failed: [{ service: 'voice', reason: "pull access denied for openpalm/voice (openpalm/voice)" }],
      error: "pull access denied for openpalm/voice (openpalm/voice)",
    });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);

    const body = (await res.json()) as {
      ok: boolean;
      restarted: string[];
      failed: { service: string; reason: string }[];
      overallSuccess: boolean;
      dockerAvailable: boolean;
      error?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.overallSuccess).toBe(false);
    expect(body.dockerAvailable).toBe(true);

    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].service).toBe('voice');
    expect(body.failed[0].reason).toMatch(/pull access denied/);

    // Pull failure is fatal — no partial "restarted" set
    expect(body.restarted).toEqual([]);

    // error summary should be populated
    expect(body.error).toBeTruthy();
  });

  test('returns 502 with stack-level failure when compose up fails with unattributable error', async () => {
    applyStackMock.mockResolvedValue({
      ok: false,
      started: [],
      failed: [{ service: 'stack', reason: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }],
      error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(502);

    const body = (await res.json()) as {
      restarted: string[];
      failed: { service: string; reason: string }[];
      overallSuccess: boolean;
    };
    expect(body.overallSuccess).toBe(false);
    expect(body.restarted).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].service).toBe('stack');
    expect(body.failed[0].reason).toMatch(/Cannot connect to the Docker daemon/);
  });

  test('returns 200 with overallSuccess:false when docker is unavailable (§6 fail loudly)', async () => {
    // User pressed "update now" but Docker is down. Per §6: a user-triggered update
    // that can't reach the daemon fails loudly (overallSuccess:false, 200 status so
    // the client can distinguish from an HTTP-level error).
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });

    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restarted: string[];
      failed: { service: string; reason: string }[];
      dockerAvailable: boolean;
      overallSuccess: boolean;
    };
    expect(body.dockerAvailable).toBe(false);
    expect(body.overallSuccess).toBe(false);
    expect(body.restarted).toEqual([]);
    expect(body.failed).toEqual([]);
    // applyStack must NOT have been called when docker is unavailable
    expect(applyStackMock).not.toHaveBeenCalled();
  });
});
