import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutomationRuntimeError,
  executeAutomation,
} from '@openpalm/lib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
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

function makeRunEvent(name: string, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request(`http://localhost/api/host/automations/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-run-test' },
    }),
    params: { name },
  } as unknown as Parameters<typeof POST>[0];
}

let originalHome: string | undefined;

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
  vi.clearAllMocks();
  vi.mocked(executeAutomation).mockResolvedValue({ ok: true, status: 'completed' });
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('POST /api/host/automations/:name/run', () => {
  test('returns auth failure before disclosing an absent host capability', async () => {
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.OP_ENABLE_ADMIN;
    const response = await POST(makeRunEvent('daily.yml', 'bad-token'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    expect(executeAutomation).not.toHaveBeenCalled();
    expect([...infoLog.mock.calls, ...errorLog.mock.calls].flat().join('\n')).not.toContain(
      'admin.automations',
    );
  });

  test('rejects traversal and unschedulable IDs before invoking the helper or AKM', async () => {
    for (const name of [
      '../escape.yml',
      'foo/bar.yml',
      '.yml',
      'foo .yml',
      'nested.yml.yml',
      'health-check.yaml',
    ]) {
      expect((await POST(makeRunEvent(name))).status).toBe(400);
    }
    expect(executeAutomation).not.toHaveBeenCalled();
  });

  test('returns 404 when execution reports no installed file', async () => {
    vi.mocked(executeAutomation).mockRejectedValue(
      new AutomationRuntimeError('not_found', 'Task file not found'),
    );
    const response = await POST(makeRunEvent('missing.yml'));
    expect(response.status).toBe(404);
  });

  test('runs a valid automation and audits its result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await POST(makeRunEvent('health-check.yml'));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      fileName: 'health-check.yml',
      status: 'completed',
      error: null,
    });
    expect(executeAutomation).toHaveBeenCalledWith(expect.any(Object), 'health-check.yml');
    const auditEntry = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { service?: string; extra?: Record<string, unknown> })
      .find((entry) => entry.service === 'admin.automations');
    expect(auditEntry?.extra).toEqual(expect.objectContaining({
      requestId: 'req-run-test',
      fileName: 'health-check.yml',
      operation: 'manual-run',
      outcome: 'success',
      runStatus: 'completed',
    }));
    expect(auditEntry?.extra).not.toHaveProperty('revision');
  });

  test.each([
    { status: 'failed', error: 'command failed' },
    { status: 'blocked', error: 'dependency unavailable' },
  ])('returns 202 for a valid semantic $status result', async (result) => {
    vi.mocked(executeAutomation).mockResolvedValue({ ok: false, ...result });
    const response = await POST(makeRunEvent('daily.yml'));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: false, ...result });
  });

  test.each([
    { code: 'unavailable' as const, status: 503 },
    { code: 'invalid_response' as const, status: 502 },
  ])('maps an execution $code error to $status', async ({ code, status }) => {
    vi.mocked(executeAutomation).mockRejectedValue(
      new AutomationRuntimeError(code, 'AKM execution failed'),
    );
    const response = await POST(makeRunEvent('daily.yml'));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: code, requestId: 'req-run-test' });
  });

  test('leaves malformed YAML semantics to AKM', async () => {
    expect((await POST(makeRunEvent('broken.yml'))).status).toBe(202);
    expect(executeAutomation).toHaveBeenCalledWith(expect.any(Object), 'broken.yml');
  });

  test('accepts consecutive dots, a 228-character ID, and foo. exactly as AKM does', async () => {
    for (const fileName of ['a..b.yml', `${'a'.repeat(228)}.yml`, 'foo..yml']) {
      expect((await POST(makeRunEvent(fileName))).status).toBe(202);
      expect(executeAutomation).toHaveBeenCalledWith(expect.any(Object), fileName);
    }
  });

  test('maps an unsafe container file to a generic 500', async () => {
    vi.mocked(executeAutomation).mockRejectedValue(
      new AutomationRuntimeError('unsafe_file', 'Task file is a symbolic link'),
    );
    const response = await POST(makeRunEvent('linked.yml'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'internal_error',
      message: 'Automation operation failed',
    });
  });
});
