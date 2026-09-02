/**
 * #655.1: guardian/health/+server.ts used to call `execFileAsync("docker",
 * …)` directly (a raw literal argv[0], bypassing dockerBin()/OP_DOCKER_BIN).
 * It now routes through docker.ts's own sanctioned `run()` wrapper (deep
 * import — the same reuse pattern the volume-ownership repair subsystem
 * already used). These tests mock that ONE seam and cover the route's real
 * branches: not-required, unreachable (no container), healthy, unhealthy,
 * and a docker-level failure.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stackEnvFile, type DockerResult } from '@openpalm/lib';
import { _replaceState } from '$lib/server/state.js';
import { makeTestState } from '$lib/server/test-helpers.js';

const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn<(args: string[], cwd?: string, timeoutMs?: number) => Promise<DockerResult>>(),
}));

vi.mock('@openpalm/lib/control-plane/docker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpalm/lib/control-plane/docker.js')>();
  return { ...actual, run: runMock };
});

let home = '';

function seedStackEnv(content: string): void {
  const path = stackEnvFile(home);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function fakeEvent(): Parameters<typeof import('./+server.js').GET>[0] {
  return { request: new Request('http://127.0.0.1/guardian/health') } as unknown as Parameters<
    typeof import('./+server.js').GET
  >[0];
}

beforeEach(() => {
  runMock.mockReset();
  const state = makeTestState();
  home = state.homeDir;
  _replaceState(state);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('GET /guardian/health', () => {
  test('reports not_deployed (200) and never touches docker when the guardian is not required', async () => {
    seedStackEnv('');
    const mod = await import('./+server.js');
    const res = await mod.GET(fakeEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toEqual({ status: 'not_deployed', service: 'guardian' });
    expect(runMock).not.toHaveBeenCalled();
  });

  test('reports unreachable (503) when no guardian container matches', async () => {
    seedStackEnv('OP_ACCESS_GUARDIAN=true\n');
    runMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
    const mod = await import('./+server.js');
    const res = await mod.GET(fakeEvent());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('unreachable');
  });

  test('reports ok (200) when the container inspect reports healthy', async () => {
    seedStackEnv('OP_ACCESS_GUARDIAN=true\n');
    runMock.mockImplementation(async (args: string[]) => {
      if (args.includes('ls')) return { ok: true, stdout: 'container123\n', stderr: '', code: 0 };
      if (args.includes('inspect')) return { ok: true, stdout: 'healthy\n', stderr: '', code: 0 };
      return { ok: false, stdout: '', stderr: 'unexpected call', code: 1 };
    });
    const mod = await import('./+server.js');
    const res = await mod.GET(fakeEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toEqual({ status: 'ok', service: 'guardian' });
  });

  test('reports the raw health status (503) when the container is unhealthy', async () => {
    seedStackEnv('OP_ACCESS_GUARDIAN=true\n');
    runMock.mockImplementation(async (args: string[]) => {
      if (args.includes('ls')) return { ok: true, stdout: 'container123\n', stderr: '', code: 0 };
      if (args.includes('inspect')) return { ok: true, stdout: 'unhealthy\n', stderr: '', code: 0 };
      return { ok: false, stdout: '', stderr: 'unexpected call', code: 1 };
    });
    const mod = await import('./+server.js');
    const res = await mod.GET(fakeEvent());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('unhealthy');
  });

  test('reports unreachable (503) with the docker error surfaced when the ls call itself fails', async () => {
    seedStackEnv('OP_ACCESS_GUARDIAN=true\n');
    runMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker: not found', code: 1 });
    const mod = await import('./+server.js');
    const res = await mod.GET(fakeEvent());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe('unreachable');
    expect(body.error).toContain('docker: not found');
  });

  test('reports unreachable (503) with the docker error surfaced when the inspect call itself fails', async () => {
    seedStackEnv('OP_ACCESS_GUARDIAN=true\n');
    runMock.mockImplementation(async (args: string[]) => {
      if (args.includes('ls')) return { ok: true, stdout: 'container123\n', stderr: '', code: 0 };
      return { ok: false, stdout: '', stderr: 'docker: daemon not running', code: 1 };
    });
    const mod = await import('./+server.js');
    const res = await mod.GET(fakeEvent());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe('unreachable');
    expect(body.error).toContain('docker: daemon not running');
  });
});
