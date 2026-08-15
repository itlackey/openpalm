/**
 * The framed OpenCode bundle's SPA-fallback paths must survive the document
 * guards, and be framable by this origin. Each expectation is a way /advanced
 * renders a dead panel instead of a workspace:
 *
 *   - landing redirect → the frame shows OpenPalm inside OpenPalm;
 *   - /login bounce → a login page inside the frame, which the app's own
 *     X-Frame-Options then refuses ("refused to connect");
 *   - X-Frame-Options: DENY → refuses even the same-origin frame this
 *     feature is built on.
 *
 * Real files under /opencode-ui/ are served by the static handler before these
 * hooks run; what this covers is the deep-link paths the SPA-fallback route
 * answers. Idiom + fixtures: hooks.server.pwa-assets.vitest.ts.
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

/** compose ps --format json output for a single healthy running service. */
const RUNNING_PS = '{"Service":"assistant","State":"running","Health":"healthy"}\n';

/** The shell and a session deep link — what the iframe actually navigates. */
const WEB_PATHS = ['/opencode-ui', '/opencode-ui/server/aHR0cA/session/ses_123'];

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

async function handleOutcome(event: RequestEvent): Promise<unknown> {
  try {
    return await handle({ event, resolve });
  } catch (thrown) {
    return thrown;
  }
}

describe('hooks.server — the OpenCode bundle paths are framable and never redirected', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-opencode-web-'));
    process.env.OP_HOME = home;
    _resetLaunchCache();
    const state = resetState('test-admin-pw');
    const kvDir = join(state.stackDir, '..', '..', 'state');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
    vi.mocked(composePs).mockResolvedValue({ ok: true, stdout: RUNNING_PS, stderr: '', code: 0 });
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('/ redirects to the landing — the baseline these exemptions are measured against', async () => {
    await expect(handleOutcome(makeEvent('/'))).resolves.toMatchObject({ location: '/chat' });
  });

  test('an unauthenticated usage route is still bounced to /login', async () => {
    const outcome = await handleOutcome(makeEvent('/connections'));
    expect((outcome as { location: string }).location).toMatch(/^\/login\?/);
  });

  test.each(WEB_PATHS)('%s reaches its route with no redirect, even unauthenticated', async (path) => {
    // The shell is public like any static asset; everything it can reach
    // flows through /oc, which enforces the session itself.
    const outcome = await handleOutcome(makeEvent(path));
    expect(outcome, `${path} must reach resolve(), not redirect`).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(200);
  });

  test.each(WEB_PATHS)('%s is framable by this same origin', async (path) => {
    const outcome = (await handleOutcome(makeEvent(path))) as Response;
    expect(outcome.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  test('every other path keeps X-Frame-Options: DENY', async () => {
    const outcome = (await handleOutcome(makeEvent('/health', '*/*'))) as Response;
    expect(outcome.headers.get('X-Frame-Options')).toBe('DENY');
  });

  test('a path that merely starts with the same letters is not exempt', async () => {
    const outcome = await handleOutcome(makeEvent('/opencode-uister'));
    expect(outcome).not.toBeInstanceOf(Response);
  });
});
