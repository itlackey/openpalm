import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-addon-detail-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeEvent(name: string, token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    params: { name },
    request: new Request(`http://localhost/admin/addons/${name}`, {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-addon-detail',
      },
    }),
  } as Parameters<typeof GET>[0];
}

function seedRegistryAddon(homeDir: string, name: string, schema = 'CHANNEL_CHAT_SECRET=\n'): void {
  const addonDir = join(homeDir, 'registry', 'addons', name);
  mkdirSync(addonDir, { recursive: true });
  writeFileSync(join(addonDir, 'compose.yml'), 'services:\n  chat:\n    image: test\n');
  writeFileSync(join(addonDir, '.env.schema'), schema);
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

describe('/admin/addons/:name route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('chat', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns enabled state and schema metadata', async () => {
    const state = getState();
    seedRegistryAddon(state.homeDir, 'chat', '# chat schema\nCHANNEL_CHAT_SECRET=\n');
    mkdirSync(join(state.homeDir, 'stack', 'addons', 'chat'), { recursive: true });
    writeFileSync(join(state.homeDir, 'stack', 'addons', 'chat', 'compose.yml'), 'services:\n  chat:\n    image: test\n');

    const res = await GET(makeEvent('chat'));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      name: string;
      enabled: boolean;
      config: { schemaPath: string; userEnvPath: string; envSchema: string };
    };
    expect(body.name).toBe('chat');
    expect(body.enabled).toBe(true);
    expect(body.config.schemaPath).toBe('registry/addons/chat/.env.schema');
    expect(body.config.userEnvPath).toBe('vault/user/user.env');
    expect(body.config.envSchema).toContain('CHANNEL_CHAT_SECRET');
  });

  test('returns 404 for unknown addons', async () => {
    const res = await GET(makeEvent('missing-addon'));
    expect(res.status).toBe(404);
  });
});
