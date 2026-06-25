/**
 * Route-level tests for POST /admin/update.
 *
 * Verifies the silent-swallow fix: when `docker compose up` reports a
 * per-service failure on stderr, the route must return 502 with a
 * structured `failed[]` list (not 200 with `restarted: [...]` that
 * pretends everything worked).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock @openpalm/lib BEFORE importing the route. The route imports a bunch
// of heavyweight functions; we only care about the apply / compose flow.
type ComposeUpFn = (args: unknown) => Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}>;
const composeUpMock = vi.fn<ComposeUpFn>();
const composePullMock = vi.fn<ComposeUpFn>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const applyUpdateMock = vi.fn<() => Promise<{ restarted: string[] }>>();
const buildManagedServicesMock = vi.fn<() => Promise<string[]>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyUpdate: (...args: unknown[]) => applyUpdateMock(...(args as [])),
    composeUp: (...args: unknown[]) => composeUpMock(...(args as [unknown])),
    composePull: (...args: unknown[]) => composePullMock(...(args as [unknown])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    buildManagedServices: (...args: unknown[]) => buildManagedServicesMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
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
  composeUpMock.mockReset();
  composePullMock.mockReset();
  composePullMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
  checkDockerMock.mockReset();
  applyUpdateMock.mockReset();
  buildManagedServicesMock.mockReset();

  applyUpdateMock.mockResolvedValue({ restarted: [] });
  buildManagedServicesMock.mockResolvedValue(['assistant', 'guardian', 'voice']);
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/update', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 200 with all services when compose succeeds', async () => {
    composeUpMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });

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

  test('returns 502 with structured failed[] when compose pull denied for one service', async () => {
    composeUpMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: [
        ' Network openpalm_default  Created',
        ' voice Pulling',
        " voice Error pull access denied for openpalm/voice, repository does not exist or may require 'docker login'",
        "Error response from daemon: pull access denied for openpalm/voice: denied: requested access to the resource is denied",
      ].join('\n'),
      code: 1,
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

    // Unaffected services should still appear in restarted
    expect(body.restarted.sort()).toEqual(['assistant', 'guardian']);
    expect(body.restarted).not.toContain('voice');

    // error summary should be populated
    expect(body.error).toBeTruthy();
  });

  test('returns 502 with stack-level failure when stderr is unattributable', async () => {
    composeUpMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      code: 1,
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

  test('returns 200 with empty restarted when docker is unavailable', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });

    const res = await POST(makePostEvent());
    // dockerAvailable=false is NOT a partial-failure state for the update
    // route — the route is still able to write the artifacts; compose just
    // didn't run. Today this returns 200; preserve that contract.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restarted: string[];
      failed: { service: string; reason: string }[];
      dockerAvailable: boolean;
      overallSuccess: boolean;
    };
    expect(body.dockerAvailable).toBe(false);
    expect(body.overallSuccess).toBe(false);
    // Note: overallSuccess=false because dockerCheck.ok was false; no
    // services were restarted.
    expect(body.restarted).toEqual([]);
    expect(body.failed).toEqual([]);
  });
});
