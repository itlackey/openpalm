/**
 * The setup redirect and the setup capability gate must never disagree.
 *
 * Both halves were individually correct and individually pinned by tests
 * (`hooks.server.setup-state.vitest.ts` asserts a non-admin process 403s
 * `/setup`; `hooks.server.client-only.vitest.ts` asserts the pre-setup
 * redirect fires) — and their COMPOSITION shipped broken: `openpalm install`
 * served a non-admin UI against a `setup_incomplete` home, so every navigation
 * was redirected to a `/setup` that the same process then refused. No test
 * exercised the pair, which is exactly how the product's front door became a
 * closed loop.
 *
 * The invariant under test is the composition itself: a process only sends a
 * browser to `/setup` if that process can serve `/setup`. This also covers the
 * container co-process, whose home is assistant-writable — a write flipping
 * install state to `setup_incomplete` must not lock every LAN client out of
 * the app.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { handle, _resetLaunchCache } from './hooks.server.js';

/**
 * Seed a home that classifies as `setup_incomplete`: a materialized skeleton
 * (core.compose.yml present, as `prepareInstallFiles` leaves it) with setup
 * not yet marked complete. This is the exact on-disk state the CLI wizard runs
 * against.
 */
function seedSetupIncompleteHome(home: string): void {
  mkdirSync(join(home, 'system', 'stack'), { recursive: true });
  writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
  mkdirSync(join(home, 'state'), { recursive: true });
  // A machine that HOSTS a stack, mid-install. The record is what selects the
  // wizard now; artifacts alone belong to a machine that has merely launched.
  writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=false\nOP_HOST_ENABLED=true\n');
}

function makeDocumentEvent(path: string): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  return {
    url,
    request: new Request(url, { headers: { host: 'localhost:3880', accept: 'text/html' } }),
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

/** Follow `handle`, returning the redirect Location or null for a real response. */
async function redirectTarget(path: string): Promise<string | null> {
  try {
    const response = await handle({ event: makeDocumentEvent(path), resolve });
    return response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null;
  } catch (err) {
    // SvelteKit's `redirect()` throws; the thrown value carries the location.
    const thrown = err as { status?: number; location?: string };
    if (typeof thrown?.location === 'string') return thrown.location;
    throw err;
  }
}

describe('hooks.server — setup redirect never outruns the setup capability', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-setup-deadlock-'));
    process.env.OP_HOME = home;
    _resetLaunchCache();
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('an admin-capable process redirects to /setup, and serves it', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    resetState('test-admin-pw');
    seedSetupIncompleteHome(home);
    _resetLaunchCache();

    expect(await redirectTarget('/chat')).toBe('/setup');

    // The route it just pointed at is genuinely served by this process.
    const setupResponse = await handle({ event: makeDocumentEvent('/setup'), resolve });
    expect(setupResponse.status).toBe(200);
  });

  test('a non-admin process does not redirect to a /setup it would refuse', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    resetState('test-admin-pw');
    seedSetupIncompleteHome(home);
    _resetLaunchCache();

    // /setup still 403s here — the capability boundary is unchanged.
    const setupResponse = await handle({ event: makeDocumentEvent('/setup'), resolve });
    expect(setupResponse.status).toBe(403);
    expect(await setupResponse.json()).toMatchObject({
      error: 'capability_not_available',
      details: { capability: 'host:setup' },
    });

    // …so nothing may be redirected there. Anything but /setup is acceptable
    // (the login wall and landing resolver still apply); a /setup target is not.
    expect(await redirectTarget('/chat')).not.toBe('/setup');
    expect(await redirectTarget('/host')).not.toBe('/setup');
  });
});
