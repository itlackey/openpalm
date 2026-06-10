import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('$lib/server/akm.js', () => ({
  runAkmCommand: vi.fn(),
  safeParseJsonObject: (value: string) => {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
}));

import { GET } from './+server.js';
import { runAkmCommand } from '$lib/server/akm.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(path = '/admin/akm/health-report?since=72h', token = 'admin-token') {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url, {
      method: 'GET',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-akm-health-report',
      },
    }),
    url,
    params: {},
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  rootDir = join(tmpdir(), `openpalm-akm-health-report-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GET /admin/akm/health-report', () => {
  test('401 without auth', async () => {
    expect((await GET(makeEvent('/admin/akm/health-report?since=72h', ''))).status).toBe(401);
  });

  test('renders html from live akm commands', async () => {
    vi.mocked(runAkmCommand)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          status: 'warn',
          since: '2026-06-07T00:00:00.000Z',
          improve: { invoked: 4, completed: 3, skipped: 1, actions: { error: 1 }, consolidation: { promoted: 5 }, memoryInference: { written: 7 }, graphExtraction: { entities: 9 }, wallTime: { medianMs: 12345 } },
          windows: [
            { name: 'current', until: '2026-06-10T00:00:00.000Z', improve: { invoked: 4, completed: 3, skipped: 1, actions: { error: 1 }, consolidation: { promoted: 5, merged: 2, deleted: 1, judgedNoAction: 3 }, memoryInference: { written: 7 }, graphExtraction: { entities: 9 }, wallTime: { medianMs: 12345 } } },
            { name: 'prior', improve: { invoked: 2, completed: 2, actions: { error: 0 }, consolidation: { promoted: 1 }, memoryInference: { written: 2 }, graphExtraction: { entities: 4 }, wallTime: { medianMs: 5000 } } },
          ],
          advisories: [{ name: 'semantic-search-runtime', status: 'warn', message: 'Semantic search status: blocked', evidence: { status: 'blocked' } }],
          hardChecks: [],
          runs: [
            { runId: 'r1', startedAt: '2026-06-09T10:00:00.000Z', wallTimeMs: 11000, ok: true, consolidation: { promoted: 2, merged: 1, deleted: 0, judgedNoAction: 1, durationMs: 3000 }, memoryInference: { written: 3, durationMs: 2000 }, graphExtraction: { entities: 4, durationMs: 1500 } },
          ],
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          proposals: [{ id: 'p1', ref: 'knowledge:test', source: 'improve', createdAt: '2026-06-10T00:00:00.000Z' }],
        }),
        stderr: '',
      });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(runAkmCommand).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['health', '--since=72h', '--group-by', 'run', '--window-compare=72h', '--format', 'json'],
      20_000,
    );
    expect(runAkmCommand).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ['proposal', 'list', '--format', 'json'],
      12_000,
    );
    const html = await res.text();
    expect(html).toContain('Knowledge Health for 72h');
    expect(html).toContain('Pending Proposals (1)');
    expect(html).toContain('chartWallTime');
  });

  test('falls back to the default 72h window for invalid values', async () => {
    vi.mocked(runAkmCommand)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ status: 'ok', since: '2026-06-07T00:00:00.000Z', improve: {}, windows: [], advisories: [], hardChecks: [], runs: [] }),
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ proposals: [] }), stderr: '' });

    await GET(makeEvent('/admin/akm/health-report?since=999h'));
    expect(runAkmCommand).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['health', '--since=72h', '--group-by', 'run', '--window-compare=72h', '--format', 'json'],
      20_000,
    );
  });
});
