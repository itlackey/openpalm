/**
 * Phase 3 — root + /splash routing through resolveLanding.
 *
 * Contract pinned here:
 *  - hooks.server.ts derives the landing for document navigations from
 *    resolveLanding(ctx, launchState) instead of the binary
 *    recommendedRoute → '/chat' | '/splash' table.
 *  - The /splash ROUTE is removed (its files are gone from routes/splash/),
 *    but the /splash PATH keeps redirecting to the resolved landing for this
 *    release. The redirect is issued by the hooks launch-routing guard —
 *    i.e. /splash is no longer exempt — so it fires BEFORE the auth guard,
 *    exactly like the existing '/' redirect (a stale /splash bookmark must
 *    not bounce through /login first).
 *  - /attention exists as the new migration/blocking surface split out of
 *    /splash. Phase 4 renamed /admin to /host; the installed_offline/broken
 *    landing (HOST_ADMIN_LANDING here) flipped with it.
 *
 * RED until Phase 3 lands, EXCEPT the test explicitly labeled
 * CHARACTERIZATION (healthy stack → /chat), which passes today and must
 * keep passing.
 *
 * Deterministic like hooks.server.vitest.ts: the Compose health probe is
 * stubbed so results don't depend on what happens to be running locally.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
  detectRuntime: vi.fn(async () => ({ dockerPresent: false, composeAvailable: false })),
}));

import { composePs } from '@openpalm/lib';
import { handle, _resetLaunchCache } from './hooks.server.js';

// Phase 4 value: the host admin surface moved from /admin to /host.
const HOST_ADMIN_LANDING = '/host';

// ── helpers (same conventions as hooks.server.vitest.ts) ─────────────────────

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'state');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

/** compose ps --format json output for a single healthy running service. */
const RUNNING_PS = '{"Service":"assistant","State":"running","Health":"healthy"}\n';

function makeEvent(path: string, accept = 'text/html'): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = {
    host: 'localhost:3880',
    accept,
  };
  return {
    url,
    request: new Request(url.toString(), { headers }),
    params: {},
    locals: {} as App.Locals,
    route: { id: path },
    platform: undefined,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

const resolve = () => Promise.resolve(new Response('ok', { status: 200 }));

const MODE_ENV_KEYS = ['OP_INSIDE_ELECTRON'] as const;

describe('hooks.server — landing routing through resolveLanding', () => {
  let home = '';
  let prevHome: string | undefined;
  let savedModeEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    process.env.PORT = '3880';
    // admin mode: host:setup is in the server capabilities, so the host
    // rows of the §6.5 matrix apply.
    process.env.OP_ENABLE_ADMIN = '1';
    savedModeEnv = {};
    for (const key of MODE_ENV_KEYS) {
      savedModeEnv[key] = process.env[key];
      delete process.env[key];
    }
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-landing-'));
    process.env.OP_HOME = home;
    _resetLaunchCache(); // the 5s launch cache is module-level — resolve fresh per test
    vi.mocked(composePs).mockResolvedValue({ ok: false, stdout: '', stderr: '', code: 1 });
    resetState('test-admin-pw');
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    for (const key of MODE_ENV_KEYS) {
      const prev = savedModeEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // ── root ('/') ──────────────────────────────────────────────────────────────

  test('CHARACTERIZATION: / with a healthy running stack redirects to /chat', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);
    vi.mocked(composePs).mockResolvedValue({ ok: true, stdout: RUNNING_PS, stderr: '', code: 0 });

    await expect(handle({ event: makeEvent('/'), resolve })).rejects.toMatchObject({
      location: '/chat',
    });
  });

  test('/ with nothing installed redirects to onboarding', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false); // no core.compose.yml → not_installed

    await expect(handle({ event: makeEvent('/'), resolve })).rejects.toMatchObject({
      location: '/connections/new?onboarding=1',
    });
  });

  test(`/ with an installed-but-offline stack redirects to ${HOST_ADMIN_LANDING} (was /splash)`, async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true); // setup complete, composePs fails → installed_offline

    await expect(handle({ event: makeEvent('/'), resolve })).rejects.toMatchObject({
      location: HOST_ADMIN_LANDING,
    });
  });

  // ── /splash → resolved landing (kept as a redirect this release) ───────────

  test('/splash with a healthy running stack redirects to /chat', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);
    vi.mocked(composePs).mockResolvedValue({ ok: true, stdout: RUNNING_PS, stderr: '', code: 0 });

    await expect(handle({ event: makeEvent('/splash'), resolve })).rejects.toMatchObject({
      location: '/chat',
    });
  });

  test(`/splash with an installed-but-offline stack redirects to ${HOST_ADMIN_LANDING}`, async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);

    await expect(handle({ event: makeEvent('/splash'), resolve })).rejects.toMatchObject({
      location: HOST_ADMIN_LANDING,
    });
  });

  test('/splash with nothing installed redirects to onboarding', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);

    await expect(handle({ event: makeEvent('/splash'), resolve })).rejects.toMatchObject({
      location: '/connections/new?onboarding=1',
    });
  });

  // ── /voice pass-through is exempt from the landing redirect ────────────────

  test('/voice/* is never bounced to the landing (speech fetches must reach the proxy)', async () => {
    // installed-but-offline: '/' would 302 to /host here. A /voice fetch must
    // NOT take that bounce — fetch() follows redirects into an HTML page, which
    // kills STT/TTS and fools the availability probe with a false 200.
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);

    // fetch()-style request: browsers send `Accept: */*`, not text/html.
    const res = await handle({ event: makeEvent('/voice/v1/models', '*/*'), resolve });
    // Falls through the landing guard to the route (stubbed resolve → 200).
    expect(res.status).toBe(200);
  });
});

// ── route split: /splash removed, /attention created (Phase 3 step 2) ────────

describe('route split — /splash removed, /attention exists', () => {
  const routesDir = fileURLToPath(new URL('./routes/', import.meta.url));

  test('the /splash route files are removed (redirect lives in hooks, not a route)', () => {
    expect(existsSync(join(routesDir, 'splash', '+page.svelte'))).toBe(false);
    expect(existsSync(join(routesDir, 'splash', '+page.server.ts'))).toBe(false);
  });

  test('the /attention route exists (migration/blocking surface split from /splash)', () => {
    expect(existsSync(join(routesDir, 'attention', '+page.svelte'))).toBe(true);
  });
});
