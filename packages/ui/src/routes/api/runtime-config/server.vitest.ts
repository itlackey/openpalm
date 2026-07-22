import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { UI_RUNTIME_CONFIG_ENV } from '@openpalm/lib';
import { GET } from './+server.js';

const ENV_KEYS = [
  UI_RUNTIME_CONFIG_ENV,
  'OP_HOME',
  'OP_INSIDE_ELECTRON',
  'OP_OPENCODE_URL',
] as const;
let savedEnv: Record<string, string | undefined>;

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
});

describe('GET /api/runtime-config', () => {
  test('serves a valid process-scoped empty config without caching it', async () => {
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

  test('derives Electron config from its existing compatibility env', async () => {
    process.env.OP_HOME = '/tmp/openpalm-runtime-config-route';
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3810';
    const response = await GET({} as never);
    const body = await response.json() as { connections: Array<{ baseUrl: string; locked: boolean }> };
    expect(response.status).toBe(200);
    expect(body.connections[0]).toEqual(
      expect.objectContaining({ baseUrl: 'http://127.0.0.1:3810', locked: true }),
    );
  });

  test('never exposes URL-embedded Electron credentials', async () => {
    process.env.OP_HOME = '/tmp/openpalm-runtime-config-route';
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_OPENCODE_URL = 'http://user:password@127.0.0.1:3810';

    const response = await GET({} as never);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('password');
  });
});
