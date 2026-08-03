import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AutomationRuntimeError, listAutomationTaskFiles } from '@openpalm/lib';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return { ...actual, listAutomationTaskFiles: vi.fn() };
});

let originalHome: string | undefined;
let homeDir = '';

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-automations-list-'));
  process.env.OP_HOME = homeDir;
  resetState('admin-token');
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

function event(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/api/host/automations', {
      headers: { cookie: `op_session=${token}` },
    }),
  } as Parameters<typeof GET>[0];
}

describe('GET /api/host/automations', () => {
  test('returns auth failure before disclosing an absent host capability', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const response = await GET(event('bad-token'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    expect(listAutomationTaskFiles).not.toHaveBeenCalled();
  });

  test('returns strict container-provided transport metadata without task semantics', async () => {
    vi.mocked(listAutomationTaskFiles).mockResolvedValue([
      {
        taskId: 'daily',
        fileName: 'daily.yml',
        size: 12,
        revision: `sha256:${'0'.repeat(64)}`,
        schedulable: true,
      },
      {
        taskId: 'foo ',
        fileName: 'foo .yml',
        size: 4,
        revision: `sha256:${'1'.repeat(64)}`,
        schedulable: false,
      },
    ]);

    const response = await GET(event());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      automations: [
        { fileName: 'daily.yml', schedulable: true },
        { fileName: 'foo .yml', schedulable: false },
      ],
    });
    expect(listAutomationTaskFiles).toHaveBeenCalledTimes(1);
  });

  test('maps an unavailable Assistant helper to 503', async () => {
    vi.mocked(listAutomationTaskFiles).mockRejectedValue(
      new AutomationRuntimeError('unavailable', 'assistant is not running'),
    );
    const response = await GET(event());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'unavailable' });
  });
});
