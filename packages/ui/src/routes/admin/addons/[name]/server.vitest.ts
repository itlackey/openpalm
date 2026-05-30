import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-addon-detail-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(name: string, token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    params: { name },
    request: new Request(`http://localhost/admin/addons/${name}`, {
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-addon-detail',
      },
    }),
  } as Parameters<typeof GET>[0];
}

function makePostEvent(name: string, body: Record<string, unknown>, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    params: { name },
    request: new Request(`http://localhost/admin/addons/${name}`, {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-addon-post',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

function seedFixedAddon(homeDir: string, name: string): void {
  const stackDir = join(homeDir, 'config', 'stack');
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, 'channels.compose.yml'), `services:\n  ${name}:\n    profiles: ["addon.${name}"]\n    image: test\n`);
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
    const res = await GET(makeGetEvent('chat', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns enabled state and schema metadata', async () => {
    const state = getState();
    seedFixedAddon(state.homeDir, 'chat');
    writeFileSync(join(state.homeDir, 'config', 'stack', 'stack.yml'), 'version: 2\naddons:\n  - chat\n');

    const res = await GET(makeGetEvent('chat'));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      name: string;
      enabled: boolean;
      config: { schemaPath: string; userEnvPath: string; envSchema: string };
    };
    expect(body.name).toBe('chat');
    expect(body.enabled).toBe(true);
    expect(body.config.schemaPath).toBe('');
    expect(body.config.userEnvPath).toBe('config/stack/stack.env');
    expect(body.config.envSchema).toBe('');
  });

  test('returns 404 for unknown addons', async () => {
    const res = await GET(makeGetEvent('missing-addon'));
    expect(res.status).toBe(404);
  });

  test('returns disabled when addon is in catalog but not in stack/addons', async () => {
    const state = getState();
    seedFixedAddon(state.homeDir, 'chat');

    const res = await GET(makeGetEvent('chat'));
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });
});

describe('POST /admin/addons/:name', () => {
  test('requires admin token', async () => {
    const res = await POST(makePostEvent('chat', { enabled: true }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 404 for unknown addon', async () => {
    const res = await POST(makePostEvent('nonexistent', { enabled: true }));
    expect(res.status).toBe(404);
  });

  test('enables an addon by updating stack.yml', async () => {
    const state = getState();
    seedFixedAddon(state.homeDir, 'chat');

    const res = await POST(makePostEvent('chat', { enabled: true }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; addon: string; enabled: boolean; changed: boolean };
    expect(body.ok).toBe(true);
    expect(body.addon).toBe('chat');
    expect(body.enabled).toBe(true);
    expect(body.changed).toBe(true);

    expect(readFileSync(join(state.homeDir, 'config', 'stack', 'stack.yml'), 'utf-8')).toContain('- chat');
  });

  test('disables an addon by updating stack.yml', async () => {
    const state = getState();
    seedFixedAddon(state.homeDir, 'chat');
    writeFileSync(join(state.homeDir, 'config', 'stack', 'stack.yml'), 'version: 2\naddons:\n  - chat\n');

    const res = await POST(makePostEvent('chat', { enabled: false }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; enabled: boolean; changed: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.changed).toBe(true);

    expect(readFileSync(join(state.homeDir, 'config', 'stack', 'stack.yml'), 'utf-8')).not.toContain('- chat');
  });

  test('reports changed=false when already in target state', async () => {
    const state = getState();
    seedFixedAddon(state.homeDir, 'chat');

    // Already disabled, request disable again
    const res = await POST(makePostEvent('chat', { enabled: false }));
    expect(res.status).toBe(200);

    const body = await res.json() as { changed: boolean };
    expect(body.changed).toBe(false);
  });
});
