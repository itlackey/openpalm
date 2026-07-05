/**
 * Route-level tests for POST /admin/update.
 *
 * Phase 3: the route is now a thin wrapper over applyUpdate() (files) +
 * applyStack() (containers). Pull failure is FATAL (§6) — no "restarted
 * from local cache" fallthrough. These tests verify the correct behaviour
 * at the route boundary.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
const patchSecretsEnvFileMock = vi.fn<(homeDir: string, patches: Record<string, string>) => void>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    applyUpdate: (...args: unknown[]) => applyUpdateMock(...(args as [])),
    applyStack: (...args: unknown[]) => applyStackMock(...(args as [unknown, unknown])),
    patchSecretsEnvFile: (...args: unknown[]) => patchSecretsEnvFileMock(...(args as [string, Record<string, string>])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    ensureHomeDirs: () => undefined,
    ensureOpenCodeConfig: () => undefined,
    ensureOpenCodeSystemConfig: () => undefined,
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [], profiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { POST } from './+server.js';

/** Hold the install lock via a foreign live PID (1 = init, always alive). */
function holdInstallLock(): void {
  const dataDir = getState().dataDir;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, '.install.lock'), `1\n${Date.now()}\n`);
}

function makePostEvent(token = 'admin-token', body: unknown = {}): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/update', {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-update-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  resetState('admin-token');
  applyStackMock.mockReset();
  checkDockerMock.mockReset();
  applyUpdateMock.mockReset();
  patchSecretsEnvFileMock.mockReset();

  applyUpdateMock.mockResolvedValue({ restarted: [] });
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  // Default: stack comes up cleanly
  applyStackMock.mockResolvedValue({ ok: true, started: ['assistant', 'guardian', 'voice'], failed: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  // The lock-contention tests write a foreign-held .install.lock into the
  // (test-shared) dataDir; remove it so it can't wedge later tests.
  rmSync(join(getState().dataDir, '.install.lock'), { force: true });
});

describe('POST /admin/update', () => {
  test('requires admin auth', async () => {
    const res = await POST(makePostEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('advances versions: writes the target versions (the resolved channel-latest) before applyStack', async () => {
    // The freeze-bug fix: "Update everything" must write the target each component
    // should advance to, else applyStack just re-applies the current tag. Targets go
    // to the legacy stack.env (the applied/current tracker), never state/ (pins).
    const res = await POST(makePostEvent('admin-token', {
      versions: { OP_ASSISTANT_VERSION: '0.12.44-beta.2', OP_GUARDIAN_VERSION: '0.12.44-beta.2' },
    }));
    expect(res.status).toBe(200);
    expect(patchSecretsEnvFileMock).toHaveBeenCalledTimes(1);
    const [, patches] = patchSecretsEnvFileMock.mock.calls[0];
    expect(patches).toEqual({ OP_ASSISTANT_VERSION: '0.12.44-beta.2', OP_GUARDIAN_VERSION: '0.12.44-beta.2' });
    // written BEFORE the stack is recreated
    expect(patchSecretsEnvFileMock.mock.invocationCallOrder[0])
      .toBeLessThan(applyStackMock.mock.invocationCallOrder[0]);
  });

  test('does not write versions when no targets are supplied (re-apply only — backward compat)', async () => {
    const res = await POST(makePostEvent());
    expect(res.status).toBe(200);
    expect(patchSecretsEnvFileMock).not.toHaveBeenCalled();
  });

  // ── 2.1: version-pin advance moved INSIDE applyUpdate's transactional boundary ──
  //
  // Advancing OP_*_VERSION pins before applyUpdate's own file-write step meant a
  // partial/failed applyUpdate could leave stack.env pointing at a version whose
  // managed files were never actually written. The pin advance must happen AFTER
  // applyUpdate succeeds (still before applyStack, which needs the new pin).

  test('full update: advances versions AFTER applyUpdate succeeds, still before applyStack', async () => {
    const res = await POST(makePostEvent('admin-token', {
      versions: { OP_ASSISTANT_VERSION: '0.12.44-beta.2' },
    }));
    expect(res.status).toBe(200);
    expect(applyUpdateMock).toHaveBeenCalledOnce();
    expect(patchSecretsEnvFileMock).toHaveBeenCalledOnce();
    expect(patchSecretsEnvFileMock.mock.invocationCallOrder[0])
      .toBeGreaterThan(applyUpdateMock.mock.invocationCallOrder[0]);
    expect(patchSecretsEnvFileMock.mock.invocationCallOrder[0])
      .toBeLessThan(applyStackMock.mock.invocationCallOrder[0]);
  });

  test('full update: does NOT advance versions when applyUpdate throws (transactional boundary)', async () => {
    applyUpdateMock.mockRejectedValue(new Error('applyUpdate failed mid-write'));

    const res = await POST(makePostEvent('admin-token', {
      versions: { OP_ASSISTANT_VERSION: '0.12.44-beta.2' },
    }));
    expect(res.status).toBe(500);
    expect(applyUpdateMock).toHaveBeenCalledOnce();
    // The pin must NOT advance — applyUpdate's file-write transaction never committed.
    expect(patchSecretsEnvFileMock).not.toHaveBeenCalled();
    expect(applyStackMock).not.toHaveBeenCalled();
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

  test('full update: returns install_in_progress and touches nothing when the lock is held', async () => {
    holdInstallLock();

    const res = await POST(makePostEvent('admin-token', {
      versions: { OP_ASSISTANT_VERSION: '0.12.44-beta.2' },
    }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('install_in_progress');
    // No file apply, no pin advance, no container apply under contention.
    expect(applyUpdateMock).not.toHaveBeenCalled();
    expect(patchSecretsEnvFileMock).not.toHaveBeenCalled();
    expect(applyStackMock).not.toHaveBeenCalled();
  });

  test('scoped service update: returns install_in_progress and skips applyStack when the lock is held', async () => {
    holdInstallLock();

    const res = await POST(makePostEvent('admin-token', { service: 'assistant' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('install_in_progress');
    expect(applyStackMock).not.toHaveBeenCalled();
  });

  // ── Scoped single-service update (§4, §7 "Update <container>") ──────────────
  //
  // Acceptance criterion: "updating one container MUST NOT touch the others."
  // The route calls applyStack({ kind: "service", service }) which pulls + recreates
  // ONLY that service with --force-recreate --no-deps.  applyUpdate (managed-file
  // apply) must NOT be called — no file changes happen on a scoped update.

  test('scoped service update: calls applyStack with kind:service and does NOT call applyUpdate', async () => {
    applyStackMock.mockResolvedValue({ ok: true, started: ['assistant'], failed: [] });

    const res = await POST(makePostEvent('admin-token', { service: 'assistant' }));
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
    expect(body.restarted).toEqual(['assistant']);
    expect(body.failed).toEqual([]);
    expect(body.dockerAvailable).toBe(true);

    // Must have called applyStack with the scoped shape — NOT kind:"all"
    expect(applyStackMock).toHaveBeenCalledOnce();
    expect(applyStackMock).toHaveBeenCalledWith(
      { kind: 'service', service: 'assistant' },
      expect.objectContaining({ files: expect.any(Array) }),
    );

    // applyUpdate must NOT be called — scoped update has no managed-file phase
    expect(applyUpdateMock).not.toHaveBeenCalled();
  });

  test('scoped service update: pull failure returns 502 with the service name in failed[]', async () => {
    applyStackMock.mockResolvedValue({
      ok: false,
      started: [],
      failed: [{ service: 'guardian', reason: 'pull access denied for openpalm/guardian' }],
      error: 'pull access denied for openpalm/guardian',
    });

    const res = await POST(makePostEvent('admin-token', { service: 'guardian' }));
    expect(res.status).toBe(502);

    const body = (await res.json()) as {
      ok: boolean;
      restarted: string[];
      failed: { service: string; reason: string }[];
      overallSuccess: boolean;
      error?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.overallSuccess).toBe(false);
    expect(body.restarted).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].service).toBe('guardian');
    expect(body.failed[0].reason).toMatch(/pull access denied/);

    // applyUpdate must NOT be called even on failure — no managed-file phase
    expect(applyUpdateMock).not.toHaveBeenCalled();
  });
});
