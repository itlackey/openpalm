/**
 * PR #571 review P1 (#511) — the client-only public lane.
 *
 * A non-admin process with no local install and no login password configured
 * (a hosted PWA origin serving the browser-owned client) must serve the
 * usage routes (/chat, /connections, /advanced) without bouncing them to
 * /login: the login endpoint 503s when no password exists, so the redirect
 * would dead-end the installed app, and there is nothing behind the wall in
 * this lane — connections live in the browser and every /api/host|assistant
 * route enforces its own auth.
 *
 * Every other lane keeps the wall: admin-capable processes, any present
 * local install, or a configured password.
 *
 * Idiom + fixtures: hooks.server.pwa-assets.vitest.ts (deterministic probes
 * via vi.mock, handleOutcome redirect capture).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
  detectRuntime: vi.fn(async () => ({ dockerPresent: false, composeAvailable: false })),
}));

import { handle, _resetLaunchCache } from './hooks.server.js';

const USAGE_ROUTES = ['/start', '/chat', '/connections', '/connections/new', '/advanced'];

function makeEvent(path: string, accept = 'text/html'): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = { host: 'localhost:3880', accept };
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

/** Run handle() and capture a thrown SvelteKit redirect as the outcome. */
async function handleOutcome(event: RequestEvent): Promise<unknown> {
  try {
    return await handle({ event, resolve });
  } catch (thrown) {
    return thrown;
  }
}

describe('hooks.server — client-only public lane (non-admin, not_installed, no password)', () => {
  let prevHome: string | undefined;
  let prevPassword: string | undefined;
  let home = '';

  beforeEach(() => {
    process.env.PORT = '3880';
    prevHome = process.env.OP_HOME;
    prevPassword = process.env.OP_UI_LOGIN_PASSWORD;
    delete process.env.OP_ENABLE_ADMIN;
    // A fresh empty OP_HOME classifies as 'not_installed'.
    const state = resetState();
    home = state.homeDir;
    // Secret bootstrap may have set a password env — this lane has none.
    delete process.env.OP_UI_LOGIN_PASSWORD;
    _resetLaunchCache();
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    if (prevPassword === undefined) delete process.env.OP_UI_LOGIN_PASSWORD;
    else process.env.OP_UI_LOGIN_PASSWORD = prevPassword;
    rmSync(home, { recursive: true, force: true });
  });

  test.each(USAGE_ROUTES)('%s is served without a /login redirect', async (path) => {
    const outcome = await handleOutcome(makeEvent(path));
    expect(outcome, `${path} must reach resolve(), not redirect`).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(200);
  });

  test('/ lands on /start so browser-owned connections decide the next route', async () => {
    await expect(handleOutcome(makeEvent('/'))).resolves.toMatchObject({
      location: '/start',
    });
  });

  test('/host stays gated — redirected to /chat by the capability gate, never served', async () => {
    await expect(handleOutcome(makeEvent('/host'))).resolves.toMatchObject({ location: '/chat' });
  });

  test('a configured password reinstates the login wall on the same routes', async () => {
    process.env.OP_UI_LOGIN_PASSWORD = 'operator-pw';
    const outcome = await handleOutcome(makeEvent('/chat'));
    expect(outcome).toMatchObject({ status: 302 });
    expect((outcome as { location: string }).location).toMatch(/^\/login\?/);
  });

  test('an admin-capable Electron/admin process gets the same narrow first-run client lane', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    for (const path of USAGE_ROUTES) {
      const outcome = await handleOutcome(makeEvent(path));
      expect(outcome, `${path} must remain usable before a password exists`).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(200);
    }
  });

  // /host before install used to 302 into /setup, which made the wizard
  // unskippable and — being gated on `Accept: text/html` — never fired for the
  // in-app admin button anyway. The surface now renders its own "not installed
  // here" notice, so it must be SERVED. Both negative assertions matter: /setup
  // is the behaviour being replaced, and /login is the dead end deleting that
  // redirect would otherwise create, since this guard runs before the role is
  // resolved and /login POSTs 503 when no password exists.
  test('/host before install is served with its not-installed notice, not redirected', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const outcome = await handleOutcome(makeEvent('/host'));
    expect(outcome, '/host must reach resolve(), not redirect').toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(200);
  });

  test('a materialized local install revokes the public lane without a /setup dead end', async () => {
    // hasCompose + OP_SETUP_COMPLETE!=='true' classifies as 'setup_incomplete'
    // (same fixture as hooks.server.pwa-assets.vitest.ts), so the public lane —
    // which requires 'not_installed' — no longer applies.
    //
    // The guard is observed as the login wall, NOT as a /setup redirect: this
    // process is non-admin, so it answers /setup with 403
    // capability_not_available, and redirecting a browser there would be a
    // closed loop (see hooks.server.setup-deadlock.vitest.ts).
    const state = resetState();
    home = state.homeDir;
    delete process.env.OP_UI_LOGIN_PASSWORD;
    writeFileSync(join(state.stackDir, 'core.compose.yml'), 'services: {}\n');
    const kvDir = join(state.stackDir, '..', '..', 'state');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\n');
    _resetLaunchCache();
    const outcome = await handleOutcome(makeEvent('/chat'));
    expect(outcome).toMatchObject({ status: 302 });
    expect((outcome as { location: string }).location).toMatch(/^\/login\?/);
  });
});
