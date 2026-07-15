/**
 * Integration tests for hooks.server.ts.
 *
 * Key scenario: sliding renewal must set a NEW op_session cookie with a
 * fresh-TTL token, not recycle the old token value. With stateless HMAC tokens
 * the old token has an immutable expiry — only a new token extends the window.
 */
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { createSession } from '$lib/server/session-store.js';
import { SESSION_COOKIE_NAME } from '$lib/server/session-cookie.js';

// Make launch routing DETERMINISTIC: stub the three host probes so the tests don't
// depend on whether docker / an assistant happens to be running on the dev machine
// (a reachable assistant on :3800 used to flip the not_installed case to /chat).
// Everything else from these modules stays real (secret/config
// startup, the pure routing derivations).
vi.mock('$lib/server/opencode-target.js', async (orig) => ({
  ...(await orig<typeof import('$lib/server/opencode-target.js')>()),
  listRemoteStatuses: vi.fn(async () => []),
}));
vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '' })),
  detectRuntime: vi.fn(async () => ({ dockerPresent: false, composeAvailable: false })),
}));

import { handle, _resetLaunchCache } from './hooks.server.js';
import { listRemoteStatuses } from '$lib/server/opencode-target.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function seedSetupComplete(stackDir: string): void {
  const kvDir = join(stackDir, '..', '..', 'knowledge', 'env');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
}

function makeEvent(path: string, token: string | null, accept = 'application/json'): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = {
    host: 'localhost:3880',
    accept,
  };
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;

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
    cookies: {} as ReturnType<RequestEvent['cookies']['get']> extends string ? RequestEvent['cookies'] : RequestEvent['cookies'],
  } as unknown as RequestEvent;
}

const resolve = () => Promise.resolve(new Response('ok', { status: 200 }));

// ── tests ─────────────────────────────────────────────────────────────────────

describe('hooks.server — sliding renewal', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    // Isolate each test in its own OP_HOME so seeded files (e.g. core.compose.yml)
    // can't leak into the next test and flip its install classification.
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-'));
    process.env.OP_HOME = home;
    _resetLaunchCache(); // the 5s launch cache is module-level — resolve fresh per test
    vi.mocked(listRemoteStatuses).mockResolvedValue([]);
    const state = resetState('test-admin-pw');
    seedSetupComplete(state.stackDir);
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME; else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('admin request gets a NEW op_session cookie (sliding window extends TTL)', async () => {
    const originalToken = createSession();
    const event = makeEvent('/admin/containers/list', originalToken);

    const response = await handle({ event, resolve });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie, 'response must include Set-Cookie').toContain(`${SESSION_COOKIE_NAME}=`);

    // Extract the new token value from the Set-Cookie header.
    const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    expect(match, 'Set-Cookie must contain a session token').toBeTruthy();
    const newToken = match?.[1];

    // The new token must be DIFFERENT from the original.
    // If it were the same, the sliding window would never extend the expiry.
    expect(newToken).not.toBe(originalToken);
  });

  test('non-admin request does not get a renewal cookie', async () => {
    const event = makeEvent('/admin/containers/list', null);

    const response = await handle({ event, resolve });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  test('first-run document navigation routes to /setup (resolveLanding, plan §6.5)', async () => {
    // Pre-Phase-3 this pinned '/' → /splash; the Phase 3 landing matrix sends
    // not_installed straight to /setup (same scenario is also pinned in
    // hooks.server.landing.vitest.ts).
    const state = resetState('test-admin-pw');
    const kvDir = join(state.stackDir, '..', '..', 'knowledge', 'env');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\n');

    const event = makeEvent('/', null, 'text/html');

    await expect(handle({ event, resolve })).rejects.toMatchObject({ location: '/setup' });
  });

  test('not_installed + an accessible remote skips splash → /chat', async () => {
    // Fresh home, nothing installed, but a reachable remote assistant is configured:
    // the user should land in chat, not on the splash.
    const state = resetState('test-admin-pw');
    const kvDir = join(state.stackDir, '..', '..', 'knowledge', 'env');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\n');
    vi.mocked(listRemoteStatuses).mockResolvedValue([
      { id: 'r1', name: 'Remote', url: 'http://example/', state: 'accessible' },
    ]);

    const event = makeEvent('/', null, 'text/html');
    await expect(handle({ event, resolve })).rejects.toMatchObject({ location: '/chat' });
  });
});
