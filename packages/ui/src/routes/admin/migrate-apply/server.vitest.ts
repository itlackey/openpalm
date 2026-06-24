/**
 * Tests for POST /admin/migrate-apply.
 *
 * Asserts:
 *  - 401 without auth
 *  - 200 + a real layout migration is applied (1 -> 2 removes the inert
 *    channels.compose.yml), report shape, and a backup is taken
 *  - idempotent: a second apply on the now-current home is a no-op
 *  - after reconcile, the managed containers are force-recreated (so they pick
 *    up seeded mounts and re-run `bun update`); a recreate failure / missing
 *    docker is surfaced as a non-fatal note, never an error
 *
 * `applyHomeReconcile` is the REAL lib implementation (the migration assertions
 * depend on it); only the docker/compose calls are mocked so the test never
 * touches a real stack.
 */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

type ComposeFn = (args: unknown) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;
const composeUpMock = vi.fn<ComposeFn>();
const checkDockerMock = vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const buildManagedServicesMock = vi.fn<() => Promise<string[]>>();

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    composeUp: (...args: unknown[]) => composeUpMock(...(args as [unknown])),
    checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
    buildManagedServices: (...args: unknown[]) => buildManagedServicesMock(...(args as [])),
    buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] }),
  };
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

let home = '';
let originalHome: string | undefined;

function seed(rel: string, content: string) {
  const full = join(home, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function makeEvent(token = 'admin-token', body: unknown = {}) {
  return {
    request: new Request('http://localhost/admin/migrate-apply', {
      method: 'POST',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'content-type': 'application/json',
        'x-request-id': 'req-migrate-apply-1',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  home = join(tmpdir(), `op-migrate-apply-${randomBytes(4).toString('hex')}`);
  mkdirSync(home, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = home;
  resetState('admin-token');
  // Default: docker present, recreate succeeds.
  composeUpMock.mockReset();
  composeUpMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
  checkDockerMock.mockReset();
  checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
  buildManagedServicesMock.mockReset();
  buildManagedServicesMock.mockResolvedValue(['assistant', 'guardian']);
  // Seed a 0.11.x layout-v1 home with a pending 1 -> 2 migration: the inert
  // channels.compose.yml must be removed by the layout migration.
  seed('knowledge/env/stack.env', 'OP_LAYOUT_VERSION=1\nOP_SETUP_COMPLETE=true\n');
  seed('config/stack/core.compose.yml', 'services: {}\n');
  seed('config/stack/channels.compose.yml', 'services: {}\n');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('POST /admin/migrate-apply', () => {
  test('returns 401 without auth', async () => {
    const res = await POST(makeEvent(''));
    expect(res.status).toBe(401);
  });

  test('applies the pending layout migration and reports it', async () => {
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.migrated).toBe(true);
    expect(body.from).toBe(1);
    expect(body.to).toBe(2);
    expect(body.applied).toContain('1->2');
    expect(body.backupDir).toBeTruthy();
    // The inert system file is gone; user/managed files remain.
    expect(existsSync(join(home, 'config/stack/channels.compose.yml'))).toBe(false);
    expect(existsSync(join(home, 'config/stack/core.compose.yml'))).toBe(true);
  });

  test('is idempotent — a second apply is a no-op', async () => {
    await POST(makeEvent());
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.migrated).toBe(false);
  });

  test('force-recreates the managed containers after the reconcile', async () => {
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    // The reconcile-only path never restarted anything — now it must.
    expect(composeUpMock).toHaveBeenCalledTimes(1);
    expect(composeUpMock.mock.calls[0]![0]).toMatchObject({ forceRecreate: true });
    expect(body.restarted).toEqual(['assistant', 'guardian']);
  });

  test('a recreate failure is non-fatal — home stays fixed, surfaced as a note', async () => {
    composeUpMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'guardian: pull access denied', code: 1 });
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.migrated).toBe(true);
    expect(body.restarted).toEqual([]);
    expect(body.notes.some((n: string) => n.includes("couldn't be restarted"))).toBe(true);
  });

  test('missing docker is non-fatal — surfaced as a note, not an error', async () => {
    checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'docker not found', code: 1 });
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(composeUpMock).not.toHaveBeenCalled();
    expect(body.notes.some((n: string) => n.includes("container runtime isn't available"))).toBe(true);
  });
});
