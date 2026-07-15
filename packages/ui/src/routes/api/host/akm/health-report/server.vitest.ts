import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    runAssistantAkmCommand: vi.fn(),
  };
});

import { GET } from './+server.js';
import { runAssistantAkmCommand } from '@openpalm/lib';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(path = '/api/host/akm/health-report?since=72h', token = 'admin-token') {
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
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = join(tmpdir(), `openpalm-akm-health-report-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GET /api/host/akm/health-report', () => {
  test('401 without auth', async () => {
    expect((await GET(makeEvent('/api/host/akm/health-report?since=72h', ''))).status).toBe(401);
  });

  test('renders html from live akm health --format html', async () => {
    vi.mocked(runAssistantAkmCommand).mockResolvedValueOnce({
      ok: true,
      stdout: '<html><body>AKM Health</body></html>',
      stderr: '',
      exitCode: 0,
      missing: false,
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(runAssistantAkmCommand).toHaveBeenCalledTimes(1);
    expect(runAssistantAkmCommand).toHaveBeenCalledWith(
      expect.anything(),
      ['health', '--since=72h', '--format', 'html'],
      30_000,
    );
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('content-security-policy')).not.toContain('cdn.jsdelivr.net');
  });

  test('falls back to the default 72h window for invalid values', async () => {
    vi.mocked(runAssistantAkmCommand).mockResolvedValueOnce({
      ok: true,
      stdout: '<html><body>AKM Health</body></html>',
      stderr: '',
      exitCode: 0,
      missing: false,
    });

    await GET(makeEvent('/api/host/akm/health-report?since=999h'));
    expect(runAssistantAkmCommand).toHaveBeenCalledWith(
      expect.anything(),
      ['health', '--since=72h', '--format', 'html'],
      30_000,
    );
  });

  test('returns error html when akm is missing', async () => {
    vi.mocked(runAssistantAkmCommand).mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'akm: command not found',
      exitCode: 127,
      missing: true,
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('AKM is not available');
  });

  test('returns error html when akm command fails', async () => {
    vi.mocked(runAssistantAkmCommand).mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'internal error',
      exitCode: 1,
      missing: false,
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('AKM health report unavailable');
  });
});
