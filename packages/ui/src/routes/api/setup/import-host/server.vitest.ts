import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    importHostOpenCode: vi.fn(() => ({ imported: { providers: 1, credentials: 1 }, conflicts: [] })),
    detectHostOpenCode: vi.fn(() => ({ providerCount: 1, credentialCount: 1, authPath: '/tmp/host-auth-unused.json' })),
    checkDocker: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
  };
});

vi.mock('$lib/server/opencode/http.js', () => ({
  opencodeFetch: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/docker.js', () => ({
  composeRestart: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
}));

import { opencodeFetch } from '$lib/server/opencode/http.js';
import { composeRestart } from '$lib/server/docker.js';

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = join(tmpdir(), `openpalm-setup-import-host-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(rootDir, 'config', 'stack'), { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('POST /api/setup/import-host', () => {
  test('pushes merged imported auth.json and restarts only assistant', async () => {
    writeFileSync(join(rootDir, 'config', 'stack', 'auth.json'), JSON.stringify({
      groq: { type: 'api', key: 'gsk-imported' },
    }));

    const res = await POST({} as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; livePushed: number; restarted: string[] };

    expect(body.ok).toBe(true);
    expect(body.livePushed).toBe(1);
    expect(body.restarted).toEqual(['assistant']);
    expect(vi.mocked(opencodeFetch)).toHaveBeenCalledWith('/auth/groq', expect.objectContaining({ method: 'PUT' }));
    expect(vi.mocked(composeRestart)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(composeRestart)).toHaveBeenCalledWith(['assistant'], expect.any(Object));
  });
});
