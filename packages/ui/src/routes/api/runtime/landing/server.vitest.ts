/**
 * Tests for GET /api/runtime/landing (review findings J2/J3).
 *
 * J2: Electron's default surface bypassed the host landing matrix's recovery
 * branches entirely — a stopped/crashed/unhealthy stack at launch landed the
 * window in a dead client chat instead of /host (installed_offline) or
 * /host?tab=diagnostics (installed_broken), because nothing outside the host
 * UI's own SSR/hooks navigation ever consulted resolveLanding(). This
 * endpoint exposes the SAME resolver as a plain, unauthenticated, no-store
 * JSON probe so any surface (Electron, `openpalm app`, a future client) can
 * ask "where should I land?" without needing a document navigation.
 *
 * J3 (landing/migration-gate half): nothing produces a 'pending' migration
 * status yet, but resolveLanding already routes it to /attention — this
 * endpoint surfaces that value the moment something does, with zero changes
 * needed here later.
 *
 * Contract (cross-lane — the CLI lane codes against this in parallel):
 *   GET /api/runtime/landing → 200 JSON {"landing": "/chat" | "/start" | "/setup" |
 *   "/host" | "/host?tab=diagnostics" | "/attention" | ...}, unauthenticated,
 *   Cache-Control: no-store.
 *
 * Deterministic like hooks.server.landing.vitest.ts: the Compose health probe
 * is stubbed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
  detectRuntime: vi.fn(async () => ({ dockerPresent: false, composeAvailable: false })),
}));

import { composePs } from '@openpalm/lib';
import { GET } from './+server.js';
import { _resetLaunchCache } from '$lib/server/landing.js';

const RUNNING_PS = '{"Service":"assistant","State":"running","Health":"healthy"}\n';

function makeEvent(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
) {
  const url = new URL('http://127.0.0.1:3880/api/runtime/landing');
  return {
    url,
    request: new Request(url, { headers }),
    params: {},
    locals: {},
    cookies: { get: (name: string) => cookies[name] },
    route: { id: '/api/runtime/landing' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as Parameters<typeof GET>[0];
}

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'state');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

describe('GET /api/runtime/landing — public landing-resolver endpoint (J2/J3)', () => {
  let home = '';
  let prevHome: string | undefined;
  let prevAdmin: string | undefined;

  beforeEach(() => {
    prevHome = process.env.OP_HOME;
    prevAdmin = process.env.OP_ENABLE_ADMIN;
    // admin mode: host:setup is in the server capabilities, so the host
    // rows of the §6.5 matrix apply — the ones Electron/CLI actually need.
    process.env.OP_ENABLE_ADMIN = '1';
    home = mkdtempSync(join(tmpdir(), 'op-runtime-landing-'));
    process.env.OP_HOME = home;
    _resetLaunchCache();
    vi.mocked(composePs).mockResolvedValue({ ok: false, stdout: '', stderr: '', code: 1 });
    resetState('test-admin-pw');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    if (prevAdmin === undefined) delete process.env.OP_ENABLE_ADMIN;
    else process.env.OP_ENABLE_ADMIN = prevAdmin;
    rmSync(home, { recursive: true, force: true });
  });

  test('returns 200 with no session cookie (no auth required)', async () => {
    seedStackEnv(resetState('test-admin-pw').stackDir, true);
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
  });

  test('returns 200 with a garbage session cookie (auth is never consulted)', async () => {
    seedStackEnv(resetState('test-admin-pw').stackDir, true);
    const res = await GET(makeEvent({ cookie: 'op_session=not-a-real-token' }));
    expect(res.status).toBe(200);
  });

  test('responds with JSON', async () => {
    seedStackEnv(resetState('test-admin-pw').stackDir, true);
    const res = await GET(makeEvent());
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  test('sets Cache-Control: no-store so a stale landing is never served from cache', async () => {
    seedStackEnv(resetState('test-admin-pw').stackDir, true);
    const res = await GET(makeEvent());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a healthy running stack resolves to /chat', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);
    vi.mocked(composePs).mockResolvedValue({ ok: true, stdout: RUNNING_PS, stderr: '', code: 0 });
    const res = await GET(makeEvent());
    const body = (await res.json()) as { landing: string };
    expect(body.landing).toBe('/chat');
  });

  test('nothing installed resolves to /start for browser-owned bootstrap', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);
    const res = await GET(makeEvent());
    const body = (await res.json()) as { landing: string };
    expect(body.landing).toBe('/start');
  });

  // The server cannot read IndexedDB, so before this hint existed a user who
  // had configured a remote assistant was routed through /start on every
  // single launch and only escaped via /start's own client-side redirect.
  test('nothing installed resolves to /chat when the browser reports saved connections', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);
    const res = await GET(makeEvent({}, { op_has_connections: '1' }));
    const body = (await res.json()) as { landing: string };
    expect(body.landing).toBe('/chat');
  });

  test('a hint with any other value is ignored — only an exact "1" counts', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);
    const res = await GET(makeEvent({}, { op_has_connections: 'yes-please' }));
    const body = (await res.json()) as { landing: string };
    expect(body.landing).toBe('/start');
  });

  test('an installed-but-offline stack resolves to /host (J2 — stopped/crashed at launch)', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true); // setup complete, composePs fails -> installed_offline
    const res = await GET(makeEvent());
    const body = (await res.json()) as { landing: string };
    expect(body.landing).toBe('/host');
  });
});
