import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { BUILTIN_ADDON_IDS, type AddonProfile } from '@openpalm/lib';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';

// This suite exercises addon listing/toggling, not host capability probing:
// annotateAddonProfileAvailability shells out to docker per profile (image
// inspect, runtime detection), which is absent in some test environments and
// has blown the 5s test budget on cold CI runners where docker exists but is
// slow to first-invoke. Everything else in @openpalm/lib stays real.
// The compose layer is stubbed too: an enable now brings the addon's services
// up, and a unit test must neither depend on a docker daemon being present nor
// actually start containers. `composeCalls` is what the enable assertions read.
const composeCalls = vi.hoisted(() => [] as string[][]);
vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  annotateAddonProfileAvailability: async (profiles: AddonProfile[]) =>
    profiles.map((p) => ({ ...p, available: true })),
  checkDocker: async () => ({ ok: true }),
  activateComposeCommand: async (_state: unknown, args: string[]) => {
    composeCalls.push(args);
  },
}));

import { GET, POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-addons-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/api/host/addons', {
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-addons-list',
      },
    }),
  } as Parameters<typeof GET>[0];
}

function makePostEvent(body: Record<string, unknown>, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/api/host/addons', {
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
  const envDir = join(homeDir, 'state');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'stack.env'), `OP_ENABLED_ADDONS=${name}\n`);
}

function readEnabledAddonsEnv(homeDir: string): string {
  // OP_ENABLED_ADDONS is app-written addon state → state/ (constitution §1).
  const p = join(homeDir, 'state', 'stack.env');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

let originalHome: string | undefined;

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  composeCalls.length = 0;
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('GET /api/host/addons', () => {
  test('requires admin token', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('surfaces the experimental flag so the tab can warn before an enable', async () => {
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as { addons: { name: string; experimental: boolean }[] };
    const flagged = body.addons.filter((a) => a.experimental).map((a) => a.name).sort();
    expect(flagged).toEqual(['paperclip', 'remote']);
    // Advisory, never a gate: an experimental addon is still offered like any
    // other, so the list itself must be unchanged.
    expect(body.addons).toHaveLength(BUILTIN_ADDON_IDS.length);
  });

  test('returns built-in addons without requiring a registry', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { addons: unknown[] };
    // Derived from BUILTIN_ADDON_IDS rather than hardcoded. This count was a
    // literal twice and went stale both times an addon was added — the route
    // is meant to return exactly the built-in set, so assert that relationship
    // instead of a number that has to be hand-maintained alongside it.
    expect(body.addons).toHaveLength(BUILTIN_ADDON_IDS.length);
  });

  test('lists available addons with enabled status', async () => {
    const state = getState();
    enableAddon(state.homeDir, 'discord');

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as { addons: Array<{ name: string; enabled: boolean; available: boolean }> };
    expect(body.addons).toHaveLength(BUILTIN_ADDON_IDS.length);

    const discord = body.addons.find((a) => a.name === 'discord');
    expect(discord).toEqual({ name: 'discord', enabled: true, available: true, experimental: false });
  });
});

describe('POST /api/host/addons', () => {
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

  test('returns structured 409 without enabling an addon while an update holds the install lock', async () => {
    const state = getState();
    const lockPath = join(state.dataDir, '.install.lock');
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(lockPath, `1\n${Date.now()}\n`);

    try {
      const res = await POST(makePostEvent({ name: 'discord', enabled: true }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'install_in_progress' });
      expect(readEnabledAddonsEnv(state.homeDir)).not.toContain('discord');
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  test('enables an addon AND brings its services up', async () => {
    // The regression: enable wrote OP_ENABLED_ADDONS and stopped there, so the
    // compose profile went active with no container behind it.
    const state = getState();
    seedRegistryAddon(state.homeDir, 'discord');

    const res = await POST(makePostEvent({ name: 'discord', enabled: true }));
    expect(res.status).toBe(202);

    const body = await res.json() as {
      ok: boolean; addon: string; enabled: boolean; changed: boolean; deploying: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.addon).toBe('discord');
    expect(body.enabled).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.deploying).toBe(true);
    expect(readEnabledAddonsEnv(state.homeDir)).toContain('OP_ENABLED_ADDONS=discord');
    expect(composeCalls).toContainEqual(['up', '-d', 'discord']);
  });

  test('a no-op re-enable does not recreate a running container', async () => {
    const state = getState();
    seedRegistryAddon(state.homeDir, 'discord');
    enableAddon(state.homeDir, 'discord');

    const res = await POST(makePostEvent({ name: 'discord', enabled: true }));
    expect(res.status).toBe(200);
    expect(composeCalls).toHaveLength(0);
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

  // Voice is the one addon with a hardware profile. A profile change while the
  // addon is DISABLED must persist the selection only — no enable, no compose.
  test('voice profile change while disabled persists the selection without enabling', async () => {
    const state = getState();
    const stackDir = join(state.homeDir, 'system', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(
      join(stackDir, 'services.compose.yml'),
      'services:\n' +
        '  voice:\n    profiles: ["addon.voice.cpu"]\n    image: test\n' +
        '  voice-cuda:\n    profiles: ["addon.voice.cuda"]\n    image: test\n'
    );

    const res = await POST(makePostEvent({ name: 'voice', profile: 'addon.voice.cpu' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(readEnabledAddonsEnv(state.homeDir)).not.toContain('OP_ENABLED_ADDONS=voice');
    expect(readEnabledAddonsEnv(state.homeDir)).toContain('OP_VOICE_PROFILE=addon.voice.cpu');
  });

  test('voice profile change rejects an unknown profile id', async () => {
    const res = await POST(makePostEvent({ name: 'voice', profile: 'addon.voice.quantum' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_profile' });
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
