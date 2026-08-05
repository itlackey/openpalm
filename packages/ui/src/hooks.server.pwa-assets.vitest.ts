/**
 * #511 — the static PWA assets (manifest, service worker, icons) must be
 * reachable pre-auth and regardless of setup state, exactly like /health.
 * A browser needs to fetch them (to decide installability / register the
 * worker) before the user has ever logged in or finished setup; if any of
 * the three document-navigation guards in hooks.server.ts caught them, the
 * manifest/service-worker fetch would come back as a redirected HTML page
 * instead of the real asset, and the browser would never offer the install
 * prompt.
 *
 * Idiom + fixtures: hooks.server.landing.vitest.ts / hooks.server.admin-
 * 404.vitest.ts (deterministic host probes via vi.mock, admin-mode stack
 * fixtures).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
  detectRuntime: vi.fn(async () => ({ dockerPresent: false, composeAvailable: false })),
}));

import { composePs } from '@openpalm/lib';
import { handle, _resetLaunchCache } from './hooks.server.js';

const PWA_ASSET_PATHS = [
  '/manifest.webmanifest',
  '/service-worker.js',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/maskable-512x512.png',
];

/** compose ps --format json output for a single healthy running service. */
const RUNNING_PS = '{"Service":"assistant","State":"running","Health":"healthy"}\n';

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

describe('hooks.server — static PWA assets are exempt from every document-navigation guard (#511)', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-pwa-assets-'));
    process.env.OP_HOME = home;
    _resetLaunchCache();
    vi.mocked(composePs).mockResolvedValue({ ok: false, stdout: '', stderr: '', code: 1 });
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // ── setup guard: setup incomplete but a stack is already materialized ──────

  describe('setup guard (setup incomplete, stack already materialized)', () => {
    beforeEach(() => {
      const state = resetState('test-admin-pw');
      // hasCompose=true + OP_SETUP_COMPLETE!=='true' + no guardian tokens
      // classifies as 'setup_incomplete' (classifyLocalInstall), i.e.
      // localInstallState !== 'not_installed' — exactly the condition that
      // makes the FIRST hooks.server.ts guard redirect document navigations
      // to /setup.
      writeFileSync(join(state.stackDir, 'core.compose.yml'), 'services: {}\n');
      const kvDir = join(state.stackDir, '..', '..', 'state');
      mkdirSync(kvDir, { recursive: true });
      // A machine that HOSTS a stack, mid-install — the setup guard keys on
      // that record now, not on the artifacts a launch leaves behind.
      writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\nOP_HOST_ENABLED=true\n');
    });

    test('a normal document navigation (/chat) is redirected to /setup', async () => {
      await expect(handleOutcome(makeEvent('/chat'))).resolves.toMatchObject({ location: '/setup' });
    });

    test.each(PWA_ASSET_PATHS)('%s is served, not redirected to /setup', async (path) => {
      const outcome = await handleOutcome(makeEvent(path));
      expect(outcome, `${path} must reach resolve(), not redirect`).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(200);
    });
  });

  // ── landing + auth guards: setup complete, healthy running stack ───────────

  describe('landing + login guards (setup complete, healthy running stack, unauthenticated)', () => {
    beforeEach(() => {
      const state = resetState('test-admin-pw');
      const kvDir = join(state.stackDir, '..', '..', 'state');
      mkdirSync(kvDir, { recursive: true });
      writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
      vi.mocked(composePs).mockResolvedValue({ ok: true, stdout: RUNNING_PS, stderr: '', code: 0 });
    });

    test('/ redirects to /chat (landing) — baseline this exemption is tested against', async () => {
      await expect(handleOutcome(makeEvent('/'))).resolves.toMatchObject({ location: '/chat' });
    });

    test('/connections falls through the landing guard (usage route) but is still bounced to /login', async () => {
      const outcome = await handleOutcome(makeEvent('/connections'));
      expect(outcome).toMatchObject({ status: 302 });
      expect((outcome as { location: string }).location).toMatch(/^\/login\?/);
    });

    test.each(PWA_ASSET_PATHS)(
      '%s is served with no redirect at all — neither the landing gate nor /login',
      async (path) => {
        const outcome = await handleOutcome(makeEvent(path));
        expect(outcome, `${path} must reach resolve(), not redirect`).toBeInstanceOf(Response);
        expect((outcome as Response).status).toBe(200);
      },
    );

    test('a fetch-style request (Accept: */*) for the manifest also reaches resolve() unbothered', async () => {
      const outcome = await handleOutcome(makeEvent('/manifest.webmanifest', '*/*'));
      expect(outcome).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(200);
    });
  });
});
