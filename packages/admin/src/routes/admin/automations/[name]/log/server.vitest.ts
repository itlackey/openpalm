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

function seedTaskLogs(cacheDir: string, id: string, entries: Array<{ ts: string; content: string }>): void {
  const logDir = join(cacheDir, 'akm', 'tasks', 'logs', id);
  mkdirSync(logDir, { recursive: true });
  for (const { ts, content } of entries) {
    writeFileSync(join(logDir, `${ts}.log`), content + '\n');
  }
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
    const res = await GET(makeLogEvent('health-check', {}, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when name contains traversal', async () => {
    const res = await GET(makeLogEvent('../etc/passwd'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  test('returns 400 when name contains a slash', async () => {
    const res = await GET(makeLogEvent('foo/bar'));
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit is negative', async () => {
    const res = await GET(makeLogEvent('health-check', { limit: '-1' }));
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit is zero', async () => {
    const res = await GET(makeLogEvent('health-check', { limit: '0' }));
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit is non-numeric', async () => {
    const res = await GET(makeLogEvent('health-check', { limit: 'abc' }));
    expect(res.status).toBe(400);
  });

  test('caps limit at MAX_LIMIT (500) silently', async () => {
    const res = await GET(makeLogEvent('health-check', { limit: '999999' }));
    expect(res.status).toBe(200);
  });

  test('returns empty lines when no log files exist', async () => {
    const res = await GET(makeLogEvent('health-check'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; lines: unknown[] };
    expect(body.name).toBe('health-check');
    expect(body.lines).toEqual([]);
  });

  test('returns log lines from akm task log dir newest-first', async () => {
    const state = getState();
    seedTaskLogs(state.cacheDir, 'health-check', [
      { ts: '2026-05-15T03-00-00-000Z', content: 'run-old' },
      { ts: '2026-05-16T03-00-00-000Z', content: 'run-new' },
    ]);

    const res = await GET(makeLogEvent('health-check'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines[0]).toBe('run-new');
    expect(body.lines[1]).toBe('run-old');
  });

  test('applies the requested limit', async () => {
    const state = getState();
    const content = Array.from({ length: 10 }, (_, i) => `entry-${i}`).join('\n');
    seedTaskLogs(state.cacheDir, 'health-check', [
      { ts: '2026-05-16T03-00-00-000Z', content },
    ]);

    const res = await GET(makeLogEvent('health-check', { limit: '3' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: unknown[] };
    expect(body.lines).toHaveLength(3);
  });

  test('strips .md suffix from name', async () => {
    const state = getState();
    seedTaskLogs(state.cacheDir, 'health-check', [
      { ts: '2026-05-16T03-00-00-000Z', content: 'found-entry' },
    ]);

    const res = await GET(makeLogEvent('health-check.md'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; lines: string[] };
    expect(body.name).toBe('health-check');
    expect(body.lines).toContain('found-entry');
  });
});
