import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-addons-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/addons', {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-addons-list',
      },
    }),
  } as Parameters<typeof GET>[0];
}

function makePostEvent(body: Record<string, unknown>, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/addons', {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-addons-post',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

function seedRegistryAddon(homeDir: string, name: string): void {
  const addonDir = join(homeDir, 'registry', 'addons', name);
  mkdirSync(addonDir, { recursive: true });
  writeFileSync(join(addonDir, 'compose.yml'), `services:\n  ${name}:\n    image: test\n`);
  writeFileSync(join(addonDir, '.env.schema'), `CHANNEL_${name.toUpperCase()}_SECRET=\n`);
}

function enableAddon(homeDir: string, name: string): void {
  const dir = join(homeDir, 'stack', 'addons', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compose.yml'), `services:\n  ${name}:\n    image: test\n`);
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

describe('GET /admin/addons', () => {
  test('requires admin token', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns empty list when no addons in registry', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { addons: unknown[] };
    expect(body.addons).toEqual([]);
  });

  test('lists available addons with enabled status', async () => {
    const state = getState();
    seedRegistryAddon(state.homeDir, 'chat');
    seedRegistryAddon(state.homeDir, 'discord');
    enableAddon(state.homeDir, 'chat');

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as { addons: Array<{ name: string; enabled: boolean; available: boolean }> };
    expect(body.addons).toHaveLength(2);

    const chat = body.addons.find((a) => a.name === 'chat');
    const discord = body.addons.find((a) => a.name === 'discord');
    expect(chat).toEqual({ name: 'chat', enabled: true, available: true });
    expect(discord).toEqual({ name: 'discord', enabled: false, available: true });
  });
});

describe('POST /admin/addons', () => {
  test('requires admin token', async () => {
    const res = await POST(makePostEvent({ name: 'chat', enabled: true }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when name is missing', async () => {
    const res = await POST(makePostEvent({ enabled: true }));
    expect(res.status).toBe(400);
  });

  test('returns 404 for unknown addon', async () => {
    const res = await POST(makePostEvent({ name: 'nonexistent', enabled: true }));
    expect(res.status).toBe(404);
  });

  test('enables an addon', async () => {
    const state = getState();
    seedRegistryAddon(state.homeDir, 'chat');

    const res = await POST(makePostEvent({ name: 'chat', enabled: true }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; addon: string; enabled: boolean; changed: boolean };
    expect(body.ok).toBe(true);
    expect(body.addon).toBe('chat');
    expect(body.enabled).toBe(true);
    expect(body.changed).toBe(true);
    expect(existsSync(join(state.homeDir, 'stack', 'addons', 'chat', 'compose.yml'))).toBe(true);
  });

  test('disables an enabled addon', async () => {
    const state = getState();
    seedRegistryAddon(state.homeDir, 'chat');
    enableAddon(state.homeDir, 'chat');

    const res = await POST(makePostEvent({ name: 'chat', enabled: false }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(existsSync(join(state.homeDir, 'stack', 'addons', 'chat'))).toBe(false);
  });
});
