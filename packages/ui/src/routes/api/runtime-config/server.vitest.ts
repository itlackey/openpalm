import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UI_RUNTIME_CONFIG_ENV } from '@openpalm/lib';
import { GET } from './+server.js';

const ENV_KEYS = [
  UI_RUNTIME_CONFIG_ENV,
  'OP_HOME',
  'OP_INSIDE_ELECTRON',
  'OP_OPENCODE_URL',
  'OP_UI_DEFAULT_ASSISTANT_URL',
] as const;
let savedEnv: Record<string, string | undefined>;
const tempDirs: string[] = [];

function createHome(installed: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-runtime-config-route-'));
  tempDirs.push(home);
  if (installed) {
    mkdirSync(join(home, 'system', 'stack'), { recursive: true });
    writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\n');
  }
  return home;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/runtime-config', () => {
  test('serves a valid process-scoped empty config without caching it', async () => {
    process.env.OP_HOME = createHome(false);
    process.env[UI_RUNTIME_CONFIG_ENV] = '{"connections":[]}';
    const response = await GET({} as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ connections: [] });
  });

  test('rejects malformed process JSON instead of exposing an unchecked shape', async () => {
    process.env[UI_RUNTIME_CONFIG_ENV] = '{"connections":[{"id":7}]}';
    const response = await GET({} as never);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'invalid_runtime_config' });
  });

  test('returns 404 when no process config exists so static assistant config can be used', async () => {
    const response = await GET({} as never);
    expect(response.status).toBe(404);
  });

  test('seeds Electron the same-origin proxy path, not its server-side upstream', async () => {
    // OP_OPENCODE_URL is where THIS process finds OpenCode. Handing it to the
    // browser was the old behavior and is now a leak of an address only the
    // server can reach — /oc resolves it per-request instead.
    process.env.OP_HOME = createHome(true);
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3810';
    const response = await GET({} as never);
    const body = await response.json() as { connections: Array<{ baseUrl: string; locked: boolean }> };
    expect(response.status).toBe(200);
    expect(body.connections[0]).toEqual(
      expect.objectContaining({ baseUrl: '/oc', locked: true }),
    );
  });

  test('never exposes URL-embedded credentials from the browser-facing override', async () => {
    process.env.OP_HOME = createHome(true);
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_UI_DEFAULT_ASSISTANT_URL = 'http://user:password@assistant.example';

    const response = await GET({} as never);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).toContain('assistant.example');
    expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('password');
  });

  test('returns an empty Electron seed before a local stack is installed', async () => {
    process.env.OP_HOME = createHome(false);
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3810';
    const response = await GET({} as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [] });
  });

  test('materializes local config after setup completes in the same process', async () => {
    const homeDir = createHome(false);
    process.env.OP_HOME = homeDir;
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3810';
    process.env[UI_RUNTIME_CONFIG_ENV] = '{"connections":[]}';

    const before = await GET({} as never);
    expect(await before.json()).toEqual({ connections: [] });

    mkdirSync(join(homeDir, 'system', 'stack'), { recursive: true });
    writeFileSync(join(homeDir, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\n');

    const after = await GET({} as never);
    expect(await after.json()).toEqual({
      connections: [expect.objectContaining({
        id: 'openpalm-assistant-opencode',
        baseUrl: '/oc',
        locked: true,
      })],
    });
  });
});
