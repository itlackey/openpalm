import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        cookie: `op_session=${token}`,
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
        cookie: `op_session=${token}`,
        'x-request-id': 'req-addons-post',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

function seedRegistryAddon(homeDir: string, name: string): void {
  const stackDir = join(homeDir, 'system', 'stack');
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, 'portals.compose.yml'), `services:\n  ${name}:\n    profiles: ["addon.${name}"]\n    image: test\n`);
}

function enableAddon(homeDir: string, name: string): void {
  const envDir = join(homeDir, 'knowledge', 'env');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'stack.env'), `OP_ENABLED_ADDONS=${name}\n`);
}

function readEnabledAddonsEnv(homeDir: string): string {
  const p = join(homeDir, 'knowledge', 'env', 'stack.env');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
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

  test('returns built-in addons without requiring a registry', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { addons: unknown[] };
    expect(body.addons).toHaveLength(8);
  });

  test('lists available addons with enabled status', async () => {
    const state = getState();
    enableAddon(state.homeDir, 'discord');

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as { addons: Array<{ name: string; enabled: boolean; available: boolean }> };
    expect(body.addons).toHaveLength(8);

    const discord = body.addons.find((a) => a.name === 'discord');
    expect(discord).toEqual({ name: 'discord', enabled: true, available: true });
  });
});

describe('POST /admin/addons', () => {
  test('requires admin token', async () => {
    const res = await POST(makePostEvent({ name: 'discord', enabled: true }, 'bad-token'));
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
    seedRegistryAddon(state.homeDir, 'discord');

    const res = await POST(makePostEvent({ name: 'discord', enabled: true }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; addon: string; enabled: boolean; changed: boolean };
    expect(body.ok).toBe(true);
    expect(body.addon).toBe('discord');
    expect(body.enabled).toBe(true);
    expect(body.changed).toBe(true);
    expect(readEnabledAddonsEnv(state.homeDir)).toContain('OP_ENABLED_ADDONS=discord');
  });

  test('disables an enabled addon', async () => {
    const state = getState();
    seedRegistryAddon(state.homeDir, 'discord');
    enableAddon(state.homeDir, 'discord');

    const res = await POST(makePostEvent({ name: 'discord', enabled: false }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(readEnabledAddonsEnv(state.homeDir)).not.toContain('discord');
  });

  // Source-of-truth regression: state.services seeds guardian (channel ingress)
  // only when a channel is enabled, ONCE at creation. Disabling the last channel
  // must rebuild the singleton so guardian stops being reported as a phantom
  // "stopped" service that no longer belongs to the stack.
  test('disabling the last channel drops guardian from the rebuilt state', async () => {
    const homeDir = getState().homeDir;
    seedRegistryAddon(homeDir, 'discord');
    enableAddon(homeDir, 'discord');
    // Rebuild the singleton from disk so it reflects the enabled channel — this
    // is the state a freshly-started host process would have.
    resetState('admin-token');
    expect(getState().services.guardian).toBeDefined();

    const res = await POST(makePostEvent({ name: 'discord', enabled: false }));
    expect(res.status).toBe(200);

    // The toggle must have busted the singleton; the next getState() re-derives
    // the gated set from the now-channel-free OP_ENABLED_ADDONS.
    expect(getState().services.guardian).toBeUndefined();
    expect(getState().services.assistant).toBeDefined();
  });
});
