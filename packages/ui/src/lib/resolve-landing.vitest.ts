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
 *  Landing matrix:
 *    host:setup capability present (admin process):
 *      migration pending          → /attention
 *      local not_installed        → /start
 *      local setup_incomplete     → /setup
 *      local installed_offline    → host admin landing
 *      local installed_broken     → host admin landing + ?tab=diagnostics
 *      otherwise (running)        → /chat
 *    no host:setup capability (non-admin process):
 *      local not_installed        → /start
 *      otherwise, 0 connections   → /connections/new
 *      otherwise, ≥1 connection   → /chat
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
  browserConnections?: boolean;
};

function makeLaunchState(overrides: Partial<TestLaunchState> = {}): TestLaunchState {
  return {
    migration: { status: 'none' },
    local: { state: 'running' },
    connections: [{ id: 'local' }],
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

  test('not_installed lands on /start with no server-visible connection', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'not_installed' }, connections: [] });
    expect(resolveLanding(hostCtx, state)).toBe('/start');
  });

  // A reachable assistant is not evidence that the user has decided how they
  // want to run OpenPalm, so the install-or-connect choice still stands. This
  // is exactly why the browser-connection fact below is a separate field.
  test('not_installed still lands on /start with a server-visible connection', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      local: { state: 'not_installed' },
      connections: [{ id: 'reachable-local-placeholder' }],
    });
    expect(resolveLanding(hostCtx, state)).toBe('/start');
  });

  // A saved browser connection IS that evidence: the user already answered
  // install-or-connect. Re-showing /start on every launch made them answer it
  // again forever, since the server cannot see browser-owned connections and
  // so could not tell them apart from a first run.
  test('not_installed skips /start once the browser has its own connections', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({
      local: { state: 'not_installed' },
      connections: [],
      browserConnections: true,
    });
    expect(resolveLanding(hostCtx, state)).toBe('/chat');
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

// ── non-admin (base) row ──────────────────────────────────────────────────────

describe('resolveLanding — non-admin process', () => {
  const ctx = makeCtx(false, BASE_EFFECTIVE);

  test('not_installed lands on /start so the browser can inspect IndexedDB', async () => {
    const resolveLanding = await loadResolveLanding();
    const state = makeLaunchState({ local: { state: 'not_installed' }, connections: [] });
    expect(resolveLanding(ctx, state)).toBe('/start');
  });

  // …but once the browser has told us it already has connections, that trip
  // through /start is pure latency: it would only bounce straight back out.
  test('not_installed skips /start once the browser reports its own connections', async () => {
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
