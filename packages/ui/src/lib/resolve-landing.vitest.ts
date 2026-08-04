/**
 * Phase 3 — resolveLanding(ctx, launchState) landing matrix.
 *
 * ALL RED until the implementation lands: the module under test does not
 * exist yet. The contract pinned here:
 *
 *  - `resolveLanding` lives in its own module at $lib/resolve-landing.ts
 *    (see CANDIDATE_MODULE_BASES for the accepted names), together with the
 *    LaunchState type derived from the existing splash launch-state logic:
 *    `local.state` is @openpalm/lib's LocalStackState, `connections` is the
 *    connection list, and `migration.status` is the blocking-migration gate
 *    ('pending' blocks; anything else does not).
 *  - `resolveLanding` is PURE: it consults ctx.effectiveCapabilities — never
 *    the global runtimeContext store — so hooks.server.ts can call it
 *    per-request on the server, where no client store exists. Capability
 *    RESOLUTION still lives only in resolveCapabilities();
 *    resolveLanding merely reads the already-resolved list.
 *
 *  Landing matrix. Being ABLE to host and actually HOSTING are different
 *  things, and only both together select the host rows — a host-capable
 *  process that hosts nothing wants what a plain client wants:
 *    host:setup capability AND hostEnabled:
 *      migration pending          → /attention
 *      local installed_broken     → host admin landing + ?tab=diagnostics
 *      local installed_offline    → host admin landing
 *      local running              → /chat
 *      otherwise                  → /setup
 *    anything else (a client, wherever it runs):
 *      nowhere to chat            → /connections/new
 *      somewhere to chat          → /chat
 *
 * Phase 4 moved the host admin landing from /admin to /host; the
 * HOST_ADMIN_LANDING constant below flipped with it (and nothing else in
 * this file).
 *
 * The module is loaded through a computed-specifier dynamic import so
 * svelte-check stays clean while the suite is red (same convention as the
 * Phase 2 red tests).
 */
import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Capability, RuntimeContext } from '$lib/types.js';

// Phase 4 value: the host admin surface moved from /admin to /host.
const HOST_ADMIN_LANDING = '/host';

// ── module loading (red-state safe) ──────────────────────────────────────────

/** Accepted file names for "its own module" in $lib (implementation picks one). */
const CANDIDATE_MODULE_BASES = ['resolve-landing', 'landing', 'resolve-landing.svelte'] as const;

type ResolveLandingFn = (ctx: RuntimeContext, launchState: unknown) => string;

async function loadResolveLanding(): Promise<ResolveLandingFn> {
  for (const base of CANDIDATE_MODULE_BASES) {
    if (!existsSync(fileURLToPath(new URL(`./${base}.ts`, import.meta.url)))) continue;
    const specifier = `./${base}.js`;
    const mod = (await import(/* @vite-ignore */ specifier)) as { resolveLanding?: unknown };
    if (typeof mod.resolveLanding !== 'function') {
      throw new Error(`$lib/${base}.ts exists but does not export resolveLanding()`);
    }
    return mod.resolveLanding as ResolveLandingFn;
  }
  throw new Error(
    `resolveLanding module not found — expected packages/ui/src/lib/<${CANDIDATE_MODULE_BASES.join(
      '|',
    )}>.ts exporting resolveLanding(ctx, launchState)`,
  );
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Effective capabilities of an admin-capable session (Electron or `openpalm admin` browser). */
const HOST_EFFECTIVE: Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  'host:setup',
  'host:stack:read',
  'host:stack:write',
  'host:containers',
  'host:addons',
  'host:updates',
  'host:logs',
  'host:secrets',
  'host:recovery',
  'host:akm-sharing',
];

/** non-admin effective baseline (resolveCapabilities output). */
const BASE_EFFECTIVE: Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  'pwa:install',
];

function makeCtx(admin: boolean, effectiveCapabilities: Capability[]): RuntimeContext {
  return {
    version: 2,
    admin,
    serverCapabilities: [...effectiveCapabilities],
    publicBaseUrl: 'http://127.0.0.1:3880',
    uiVersion: '0.0.0-test',
    routes: {},
    security: {
      hostAdminLoopbackOnly: true,
      requiresHttpsForRemoteConnections: !admin,
      csrfMode: admin ? 'loopback-origin' : 'same-site',
    },
    clientContext: { displayMode: 'browser' },
    effectiveCapabilities,
  };
}

type TestLocalState =
  | 'not_installed'
  | 'setup_incomplete'
  | 'installed_offline'
  | 'installed_broken'
  | 'running';

type TestLaunchState = {
  migration: { status: 'pending' | 'none' };
  local: { state: TestLocalState };
  connections: Array<{ id: string }>;
  hostEnabled?: boolean;
  browserConnections?: boolean;
};

function makeLaunchState(overrides: Partial<TestLaunchState> = {}): TestLaunchState {
  return {
    migration: { status: 'none' },
    local: { state: 'running' },
    connections: [{ id: 'local' }],
    // The host rows below all describe a machine that HOSTS a stack; the
    // not-hosting rows set this false explicitly.
    hostEnabled: true,
    ...overrides,
  };
}

// ── module contract ───────────────────────────────────────────────────────────

describe('resolveLanding — module contract', () => {
  test('exports resolveLanding(ctx, launchState) from its own $lib module', async () => {
    const resolveLanding = await loadResolveLanding();
    expect(typeof resolveLanding).toBe('function');
  });
});

// ── host:setup rows (admin-capable session: Electron or `openpalm admin`) ─────

describe('resolveLanding — host:setup capability present', () => {
  const hostCtx = makeCtx(true, HOST_EFFECTIVE);

  test('pending migration lands on /attention', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ migration: { status: 'pending' } });
    expect(resolveLanding(hostCtx, state)).toBe('/attention');
  });

  test('pending migration takes precedence over not_installed', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      migration: { status: 'pending' },
      local: { state: 'not_installed' },
    });
    expect(resolveLanding(hostCtx, state)).toBe('/attention');
  });

  test('pending migration takes precedence over installed_broken', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      migration: { status: 'pending' },
      local: { state: 'installed_broken' },
    });
    expect(resolveLanding(hostCtx, state)).toBe('/attention');
  });

  // A machine that is MEANT to host a stack and has not got a working one is
  // the case the wizard exists for, and it is no longer a trap: nobody who did
  // not ask to host ever arrives here.
  test('not_installed lands on the wizard', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'not_installed' }, connections: [] });
    expect(resolveLanding(hostCtx, state)).toBe('/setup');
  });

  // A reachable assistant somewhere is not a working local stack, and this
  // machine was told to run one.
  test('not_installed lands on the wizard even with a server-visible connection', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      local: { state: 'not_installed' },
      connections: [{ id: 'reachable-local-placeholder' }],
    });
    expect(resolveLanding(hostCtx, state)).toBe('/setup');
  });


  test('setup_incomplete lands on /setup', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'setup_incomplete' } });
    expect(resolveLanding(hostCtx, state)).toBe('/setup');
  });

  test(`installed_offline lands on the host admin surface (${HOST_ADMIN_LANDING})`, async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'installed_offline' } });
    expect(resolveLanding(hostCtx, state)).toBe(HOST_ADMIN_LANDING);
  });

  test('installed_broken lands on the host admin diagnostics tab', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'installed_broken' } });
    expect(resolveLanding(hostCtx, state)).toBe(`${HOST_ADMIN_LANDING}?tab=diagnostics`);
  });

  test('running (healthy) lands on /chat', async () => {
    const resolveLanding = await loadResolveLanding();
    expect(resolveLanding(hostCtx, makeLaunchState())).toBe('/chat');
  });

  test('the gate is CAPABILITY-driven, not admin-flag-driven: a host-capable server viewed without host:setup falls through to /chat', async () => {
    const resolveLanding = await loadResolveLanding();
    // admin server × standalone-pwa display: resolveCapabilities strips host:*
    // so even a broken local stack must not land this session on
    // the host admin surface it cannot use.
    const restrictedCtx = makeCtx(true, [
      'chat',
      'connections:read',
      'connections:manage',
      'connections:switch',
    ]);
    const state = makeLaunchState({ local: { state: 'installed_broken' } });
    expect(resolveLanding(restrictedCtx, state)).toBe('/chat');
  });
});

// ── host-capable, but not hosting ────────────────────────────────────────────
//
// The case the whole record exists for. A desktop app on a machine that only
// talks to a REMOTE assistant is host-CAPABLE, so it used to take the host rows
// and be marched into a local-install wizard on every launch — unfinishable on
// a machine without Docker. Capability is not intent.

describe('resolveLanding — host-capable but not hosting', () => {
  const hostCtx = makeCtx(true, HOST_EFFECTIVE);

  test('is never sent to the wizard, whatever the disk says', async () => {
    const resolveLanding = await loadResolveLanding();
    for (const local of ['not_installed', 'setup_incomplete'] as const) {
      const state = makeLaunchState({
        local: { state: local },
        connections: [],
        hostEnabled: false,
        browserConnections: true,
      });
      expect(resolveLanding(hostCtx, state), `${local} must not force the wizard`).toBe('/chat');
    }
  });

  test('lands on onboarding when there is nowhere to chat at all', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      local: { state: 'not_installed' },
      connections: [],
      hostEnabled: false,
    });
    expect(resolveLanding(hostCtx, state)).toBe('/connections/new');
  });

  // The convergence, pinned: nobody should later "unify" these branches by
  // making the client path read the host record, or vice versa.
  test('behaves exactly like a non-admin process', async () => {
    const resolveLanding = await loadResolveLanding();
    const clientCtx = makeCtx(false, BASE_EFFECTIVE);
    for (const local of ['not_installed', 'setup_incomplete', 'running'] as const) {
      for (const browserConnections of [true, false]) {
        const state = makeLaunchState({
          local: { state: local },
          connections: [],
          hostEnabled: false,
          browserConnections,
        });
        expect(resolveLanding(hostCtx, state)).toBe(resolveLanding(clientCtx, state));
      }
    }
  });
});

// ── non-admin (base) row ──────────────────────────────────────────────────────

describe('resolveLanding — non-admin process', () => {
  const ctx = makeCtx(false, BASE_EFFECTIVE);

  // A client with nowhere to chat goes to onboarding. There is no separate
  // welcome route any more: the install-or-connect question is asked on the
  // onboarding surface itself, and only where a stack could be installed.
  test('nothing installed and no connections lands on onboarding', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'not_installed' }, connections: [] });
    expect(resolveLanding(ctx, state)).toBe('/connections/new');
  });

  test('connections this browser saved are enough to go straight to chat', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      local: { state: 'not_installed' },
      connections: [],
      browserConnections: true,
    });
    expect(resolveLanding(ctx, state)).toBe('/chat');
  });

  test('zero connections lands on /connections/new', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'running' }, connections: [] });
    expect(resolveLanding(ctx, state)).toBe('/connections/new');
  });

  test('one or more connections lands on /chat', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ connections: [{ id: 'r1' }] });
    expect(resolveLanding(ctx, state)).toBe('/chat');
  });

  test('a pending migration does not divert it (no host:setup → gate skipped)', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      migration: { status: 'pending' },
      local: { state: 'running' },
      connections: [],
    });
    expect(resolveLanding(ctx, state)).toBe('/connections/new');
  });
});
