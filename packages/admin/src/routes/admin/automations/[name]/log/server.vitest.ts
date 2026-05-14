import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-log-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeLogEvent(
  name: string,
  searchParams: Record<string, string> = {},
  token = 'admin-token',
): Parameters<typeof GET>[0] {
  const url = new URL(`http://localhost/admin/automations/${encodeURIComponent(name)}/log`);
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  return {
    request: new Request(url, {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-log-test',
      },
    }),
    params: { name },
    url,
  } as unknown as Parameters<typeof GET>[0];
}

function seedSchedulerLog(logsDir: string, lines: string[]): void {
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, 'scheduler.log'), lines.join('\n') + '\n');
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

describe('GET /admin/automations/:name/log', () => {
  test('returns 401 when unauthenticated', async () => {
    const res = await GET(makeLogEvent('health-check.yml', {}, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when name contains traversal', async () => {
    const res = await GET(makeLogEvent('../etc/passwd.yml'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  test('returns 400 when name contains a slash', async () => {
    const res = await GET(makeLogEvent('foo/bar.yml'));
    expect(res.status).toBe(400);
  });

  test('returns 400 when name fails SAFE_NAME_RE', async () => {
    const res = await GET(makeLogEvent('bad name.yml'));
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit is negative', async () => {
    const res = await GET(makeLogEvent('health-check.yml', { limit: '-1' }));
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit is zero', async () => {
    const res = await GET(makeLogEvent('health-check.yml', { limit: '0' }));
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit is non-numeric', async () => {
    const res = await GET(makeLogEvent('health-check.yml', { limit: 'abc' }));
    expect(res.status).toBe(400);
  });

  test('caps limit at MAX_LIMIT (500) silently', async () => {
    // No log file, so we just verify the request doesn't 400 on huge limits.
    const res = await GET(makeLogEvent('health-check.yml', { limit: '999999' }));
    expect(res.status).toBe(200);
  });

  test('returns empty entries when scheduler.log does not exist', async () => {
    const res = await GET(makeLogEvent('health-check.yml'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileName: string; entries: unknown[] };
    expect(body.fileName).toBe('health-check.yml');
    expect(body.entries).toEqual([]);
  });

  test('filters log lines to those mentioning the automation', async () => {
    const state = getState();
    seedSchedulerLog(state.logsDir, [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', level: 'info', msg: 'fired health-check.yml ok' }),
      JSON.stringify({ ts: '2026-01-01T00:01:00Z', level: 'info', msg: 'fired other.yml ok' }),
      JSON.stringify({ ts: '2026-01-01T00:02:00Z', level: 'warn', msg: 'health-check.yml retry' }),
    ]);

    const res = await GET(makeLogEvent('health-check.yml'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ raw: string }> };
    expect(body.entries).toHaveLength(2);
    // Newest-first ordering
    expect(body.entries[0].raw).toContain('retry');
  });

  test('applies the requested limit', async () => {
    const state = getState();
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ ts: `2026-01-01T00:00:0${i}Z`, msg: `health-check.yml entry ${i}` }));
    }
    seedSchedulerLog(state.logsDir, lines);

    const res = await GET(makeLogEvent('health-check.yml', { limit: '3' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(3);
  });

  test('accepts a bare base name and normalizes to .yml', async () => {
    const state = getState();
    seedSchedulerLog(state.logsDir, [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', msg: 'fired health-check.yml ok' }),
    ]);

    const res = await GET(makeLogEvent('health-check'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileName: string; entries: unknown[] };
    expect(body.fileName).toBe('health-check.yml');
    expect(body.entries).toHaveLength(1);
  });
});
