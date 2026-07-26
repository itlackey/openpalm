/**
 * Review 2026-07-10 J3 completion.
 *
 * The launch-routing block in hooks.server.ts (handle()) exempts `/chat`,
 * `/advanced`, and `/connections` (the `usageRoute` check) from the landing
 * redirect unconditionally — so even when resolveRequestLanding() resolves
 * to `/attention` (a blocking migration in progress), those three routes
 * pass straight through instead of being diverted to the blocking screen.
 * Nothing produces `pending` today (see $lib/server/landing.ts), so this was
 * inert — but wiring it now means the gate is already correct ahead of the
 * first real migration that needs it, rather than needing a hotfix under
 * pressure once one exists.
 *
 * Fix: `usageRoute` is only exempt when the resolved landing is NOT
 * `/attention`. Any other landing (`/chat`, `/host`, `/setup`, ...)
 * continues to leave the usage routes alone, unchanged.
 *
 * Style mirrors hooks.server.landing.vitest.ts, but stubs
 * `resolveRequestLanding` directly (via $lib/server/landing.js) rather than
 * driving the underlying host probes, since the contract under test is
 * purely "what does the launch-routing block do with a given landing",
 * not how the landing itself gets resolved.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { createSession } from '$lib/server/session-store.js';
import { SESSION_COOKIE_NAME } from '$lib/server/session-cookie.js';

const resolveRequestLandingMock = vi.fn(async () => '/chat');

vi.mock('$lib/server/landing.js', async (orig) => ({
  ...(await orig<typeof import('$lib/server/landing.js')>()),
  resolveRequestLanding: (...args: unknown[]) =>
    (resolveRequestLandingMock as unknown as (...a: unknown[]) => Promise<string>)(...args),
}));

// K4 (review 2026-07-11): the gate must key off the resolver's BLOCKING_LANDINGS
// classification, not a literal '/attention' string comparison — otherwise a
// future SECOND blocking landing silently bypasses the usage-route gate. This
// hoisted, mutable set stands in for "a future second blocking landing" so
// the test below can prove the gate reacts to the set's CONTENTS, not to a
// hardcoded string.
const { blockingLandingsMock } = vi.hoisted(() => ({
  blockingLandingsMock: new Set<string>(['/attention']),
}));

vi.mock('$lib/resolve-landing.js', async (orig) => ({
  ...(await orig<typeof import('$lib/resolve-landing.js')>()),
  BLOCKING_LANDINGS: blockingLandingsMock,
}));

import { handle } from './hooks.server.js';

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'state');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

function makeEvent(path: string, token: string | null): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = {
    host: 'localhost:3880',
    accept: 'text/html',
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

describe('hooks.server — a pending-migration landing (/attention) gates the usage routes (review 2026-07-10 J3)', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-attention-gate-'));
    process.env.OP_HOME = home;
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true); // setup complete — bypass the setup-guard redirect
    resolveRequestLandingMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('GET /chat redirects to /attention when the landing resolver says so', async () => {
    resolveRequestLandingMock.mockResolvedValue('/attention');
    await expect(handle({ event: makeEvent('/chat', createSession()), resolve })).rejects.toMatchObject({
      location: '/attention',
    });
  });

  test('GET /connections redirects to /attention when the landing resolver says so', async () => {
    resolveRequestLandingMock.mockResolvedValue('/attention');
    await expect(handle({ event: makeEvent('/connections', createSession()), resolve })).rejects.toMatchObject({
      location: '/attention',
    });
  });

  test('GET /advanced redirects to /attention when the landing resolver says so', async () => {
    resolveRequestLandingMock.mockResolvedValue('/attention');
    await expect(handle({ event: makeEvent('/advanced', createSession()), resolve })).rejects.toMatchObject({
      location: '/attention',
    });
  });

  test('CONTROL: GET /chat still passes through untouched when the landing is /chat itself', async () => {
    resolveRequestLandingMock.mockResolvedValue('/chat');
    const res = await handle({ event: makeEvent('/chat', createSession()), resolve });
    expect(res.status).toBe(200);
  });

  test('CONTROL: GET /connections still passes through when the landing is /host (non-attention, non-chat)', async () => {
    // e.g. installed_broken diagnostics landing — usageRoute stays exempt for
    // every landing except /attention specifically.
    resolveRequestLandingMock.mockResolvedValue('/host?tab=diagnostics');
    const res = await handle({ event: makeEvent('/connections', createSession()), resolve });
    expect(res.status).toBe(200);
  });

});

describe('hooks.server — a SECOND blocking landing also gates the usage routes (review 2026-07-11 K4)', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-attention-gate-k4-'));
    process.env.OP_HOME = home;
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true); // setup complete — bypass the setup-guard redirect
    resolveRequestLandingMock.mockReset();
    // Simulate a future second blocking landing being registered in the
    // resolver's BLOCKING_LANDINGS set — the gate must react to this, not
    // stay hardwired to the '/attention' literal.
    blockingLandingsMock.add('/attention2-stub');
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    blockingLandingsMock.delete('/attention2-stub');
  });

  test('GET /chat redirects to the stubbed second blocking landing', async () => {
    resolveRequestLandingMock.mockResolvedValue('/attention2-stub');
    await expect(handle({ event: makeEvent('/chat', createSession()), resolve })).rejects.toMatchObject({
      location: '/attention2-stub',
    });
  });

  test('GET /connections redirects to the stubbed second blocking landing', async () => {
    resolveRequestLandingMock.mockResolvedValue('/attention2-stub');
    await expect(handle({ event: makeEvent('/connections', createSession()), resolve })).rejects.toMatchObject({
      location: '/attention2-stub',
    });
  });
});
