import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { executeAutomation } from '@openpalm/lib';
import { POST } from './+server.js';

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    executeAutomation: vi.fn().mockResolvedValue({ ok: true, status: 'completed' }),
  };
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-run-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeRunEvent(
  name: string,
  token = 'admin-token',
): Parameters<typeof POST>[0] {
  return {
    request: new Request(`http://localhost/api/host/automations/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-run-test',
      },
    }),
    params: { name },
  } as unknown as Parameters<typeof POST>[0];
}

function seedInstalledTask(stashDir: string, id: string): void {
  const tasksDir = join(stashDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${id}.yml`),
    `version: 2\nschedule: "0 3 * * *"\ncommand: ["echo","hello"]\n`,
  );
}

let originalHome: string | undefined;

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('POST /api/host/automations/:name/run', () => {
  test('returns 401 when unauthenticated', async () => {
    seedInstalledTask(getState().stashDir, 'health-check');
    const res = await POST(makeRunEvent('health-check', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when name contains traversal', async () => {
    const res = await POST(makeRunEvent('../etc/passwd'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  test('returns 400 when name contains a slash', async () => {
    const res = await POST(makeRunEvent('foo/bar'));
    expect(res.status).toBe(400);
  });

  test('rejects .yaml filenames without rejecting a valid .md task ID', async () => {
    expect((await POST(makeRunEvent('health-check.yaml'))).status).toBe(400);
    expect((await POST(makeRunEvent('health-check.md'))).status).toBe(404);
  });

  test('rejects task IDs that alias a canonical .yml filename', async () => {
    expect((await POST(makeRunEvent('health-check.yml.yml'))).status).toBe(400);
    expect((await POST(makeRunEvent('health-check.yaml.yml'))).status).toBe(400);
  });

  test('returns 404 when the automation is not installed', async () => {
    const res = await POST(makeRunEvent('not-installed'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('returns 202 and runs automation for a valid task', async () => {
    const state = getState();
    seedInstalledTask(state.stashDir, 'health-check');

    const res = await POST(makeRunEvent('health-check'));
    expect(res.status).toBe(202);

    const body = (await res.json()) as { ok: boolean; name: string; status: string; error: string | null };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('health-check');
    expect(body.status).toBe('completed');
    expect(body.error).toBeNull();
    expect(executeAutomation).toHaveBeenCalledWith(state, 'health-check');
  });

  test('accepts a bare base name without .yml', async () => {
    const state = getState();
    seedInstalledTask(state.stashDir, 'health-check');

    const res = await POST(makeRunEvent('health-check'));
    expect(res.status).toBe(202);
  });

  test('accepts an AKM task ID ending in .md', async () => {
    const state = getState();
    seedInstalledTask(state.stashDir, 'report.md');
    expect((await POST(makeRunEvent('report.md'))).status).toBe(202);
  });
});
