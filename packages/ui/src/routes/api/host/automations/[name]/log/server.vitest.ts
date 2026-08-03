import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AutomationRuntimeError, readAutomationLogs } from '@openpalm/lib';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return { ...actual, readAutomationLogs: vi.fn() };
});

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
  const url = new URL(`http://localhost/api/host/automations/${encodeURIComponent(name)}/log`);
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  return {
    request: new Request(url, {
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-log-test' },
    }),
    params: { name },
    url,
  } as unknown as Parameters<typeof GET>[0];
}

let originalHome: string | undefined;

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
  vi.clearAllMocks();
  vi.mocked(readAutomationLogs).mockResolvedValue(['newest', 'older']);
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
});

describe('GET /api/host/automations/:name/log', () => {
  test('returns auth failure before disclosing an absent host capability', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const response = await GET(makeLogEvent('daily.yml', {}, 'bad-token'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    expect(readAutomationLogs).not.toHaveBeenCalled();
  });

  test('rejects traversal and unschedulable IDs before invoking the helper', async () => {
    for (const name of [
      '../etc/passwd',
      'foo/bar.yml',
      '.yml',
      'foo .yml',
      'nested.yml.yml',
      'health-check.yaml',
    ]) {
      expect((await GET(makeLogEvent(name))).status).toBe(400);
    }
    expect(readAutomationLogs).not.toHaveBeenCalled();
  });

  test('accepts foo..yml because AKM accepts the foo. task ID', async () => {
    expect((await GET(makeLogEvent('foo..yml'))).status).toBe(200);
    expect(readAutomationLogs).toHaveBeenCalledWith(expect.any(Object), 'foo..yml', 50);
  });

  test('validates and caps the requested line limit', async () => {
    for (const limit of ['-1', '0', 'abc', '1junk', '1.5', 'NaN', 'Infinity']) {
      expect((await GET(makeLogEvent('daily.yml', { limit }))).status).toBe(400);
    }
    expect((await GET(makeLogEvent('daily.yml', { limit: '999999' }))).status).toBe(200);
    expect(readAutomationLogs).toHaveBeenLastCalledWith(expect.any(Object), 'daily.yml', 500);
  });

  test('returns container-read log lines newest-first', async () => {
    const response = await GET(makeLogEvent('daily.yml', { limit: '20' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fileName: 'daily.yml',
      lines: ['newest', 'older'],
    });
    expect(readAutomationLogs).toHaveBeenCalledWith(expect.any(Object), 'daily.yml', 20);
  });

  test('maps helper unavailability to 503', async () => {
    vi.mocked(readAutomationLogs).mockRejectedValue(
      new AutomationRuntimeError('unavailable', 'assistant is not running'),
    );
    expect((await GET(makeLogEvent('daily.yml'))).status).toBe(503);
  });
});
