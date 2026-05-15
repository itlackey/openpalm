import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { POST } from './+server.js';

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
    request: new Request(`http://localhost/admin/automations/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-run-test',
      },
    }),
    params: { name },
  } as unknown as Parameters<typeof POST>[0];
}

function seedInstalledAutomation(configDir: string, name: string): void {
  const dir = join(configDir, 'automations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.yml`),
    `description: ${name}\nschedule: daily\naction:\n  type: http\n  url: http://localhost\n`,
  );
}

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('POST /admin/automations/:name/run', () => {
  test('returns 401 when unauthenticated', async () => {
    seedInstalledAutomation(getState().configDir, 'health-check');
    const res = await POST(makeRunEvent('health-check.yml', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when name contains traversal', async () => {
    const res = await POST(makeRunEvent('../etc/passwd.yml'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  test('returns 400 when name contains a slash', async () => {
    const res = await POST(makeRunEvent('foo/bar.yml'));
    expect(res.status).toBe(400);
  });

  test('returns 400 when name fails SAFE_NAME_RE', async () => {
    const res = await POST(makeRunEvent('bad name with spaces.yml'));
    expect(res.status).toBe(400);
  });

  test('returns 404 when the automation is not installed', async () => {
    const res = await POST(makeRunEvent('not-installed.yml'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('returns 202 and writes a sentinel for a valid run', async () => {
    const state = getState();
    seedInstalledAutomation(state.configDir, 'health-check');

    const res = await POST(makeRunEvent('health-check.yml'));
    expect(res.status).toBe(202);

    const body = (await res.json()) as { ok: boolean; fileName: string; queued: boolean };
    expect(body.ok).toBe(true);
    expect(body.fileName).toBe('health-check.yml');
    expect(body.queued).toBe(true);

    const sentinelPath = join(state.stateDir, 'scheduler', 'triggers', 'health-check.yml.run');
    expect(existsSync(sentinelPath)).toBe(true);
  });

  test('accepts a bare base name and normalizes to .yml', async () => {
    const state = getState();
    seedInstalledAutomation(state.configDir, 'health-check');

    const res = await POST(makeRunEvent('health-check'));
    expect(res.status).toBe(202);

    const sentinelPath = join(state.stateDir, 'scheduler', 'triggers', 'health-check.yml.run');
    expect(existsSync(sentinelPath)).toBe(true);
  });
});
