/**
 * The host akm import must never leave the assistant with a config it cannot
 * read. That is the failure this feature is a redesign of: the import used to
 * fire automatically from the stash toggle, and when the host ran a newer akm
 * than the image it wrote keys the container rejected — every akm call in the
 * assistant died with INVALID_CONFIG_FILE and the UI said only "unavailable".
 *
 * So the contract under test is: import, ask the RUNNING assistant to load it,
 * and roll back byte-for-byte if it cannot.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

const mocks = vi.hoisted(() => ({
  akmResult: {
    ok: true,
    stdout: '{"ok":true}',
    stderr: '',
    exitCode: 0,
    missing: false,
  },
  imported: ['engines'] as string[],
}));

vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  runAssistantAkmCommand: vi.fn(async () => mocks.akmResult),
  importHostAkmConfig: vi.fn((state: { configDir: string }) => {
    // Stand in for the real merge: write something the assistant may reject.
    writeFileSync(join(state.configDir, 'akm', 'config.json'), '{"imported":true}\n');
    return { imported: mocks.imported };
  }),
  detectHostAkmConfig: vi.fn(() => ({
    configPath: '/home/u/.config/akm/config.json',
    available: true,
    engineCount: 2,
    hasEmbedding: false,
  })),
}));

import { POST } from './+server.js';

let homeDir = '';
let originalHome: string | undefined;
const PRIOR = '{"configVersion":"0.9.0","engines":{"mine":{}}}\n';

function configPath(): string {
  return join(homeDir, 'config', 'akm', 'config.json');
}

function makeEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/api/host/akm/import-host', {
      method: 'POST',
      headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
      body: '{}',
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-akm-import-'));
  mkdirSync(join(homeDir, 'config', 'akm'), { recursive: true });
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  writeFileSync(configPath(), PRIOR);
  process.env.OP_HOME = homeDir;
  resetState('admin-token');
  mocks.akmResult = { ok: true, stdout: '{"ok":true}', stderr: '', exitCode: 0, missing: false };
  mocks.imported = ['engines'];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = originalHome;
  delete process.env.OP_ENABLE_ADMIN;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('POST /api/host/akm/import-host', () => {
  test('401 without an admin session', async () => {
    expect((await POST(makeEvent('bad'))).status).toBe(401);
  });

  test('keeps the import when the assistant can load it', async () => {
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: ['engines'], changed: true, verified: true });
    expect(readFileSync(configPath(), 'utf-8')).toBe('{"imported":true}\n');
  });

  test('rolls back byte-for-byte when the assistant rejects the config', async () => {
    mocks.akmResult = {
      ok: false,
      stdout: '',
      stderr: 'Invalid config at /etc/akm/config.json:\n  - engines: Unrecognized key(s)',
      exitCode: 1,
      missing: false,
    };

    const res = await POST(makeEvent());

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('host_akm_config_incompatible');
    // The operator is told what akm actually said, not "import failed".
    expect(body.message).toContain('Unrecognized key(s)');
    // And nothing was left behind.
    expect(readFileSync(configPath(), 'utf-8')).toBe(PRIOR);
  });

  test('reports unverified rather than failing when the assistant is not running', async () => {
    mocks.akmResult = { ok: false, stdout: '', stderr: 'not found', exitCode: 127, missing: true };
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, verified: false });
  });

  test('is a no-op when the host adds nothing', async () => {
    mocks.imported = [];
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: [], changed: false });
  });
});
