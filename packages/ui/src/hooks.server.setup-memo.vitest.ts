/**
 * Review 2026-07-10 K3 — `b629dc56` dropped the setup-complete memoization
 * and the classifyLocalInstall launch cache from hooks.server.ts's setup
 * guard: `isSetupComplete` (dotenv parses + existsSync) and
 * `classifyLocalInstall` (existsSync x3-4 + two more dotenv parses) now run
 * on EVERY request — including every `/api/*`/`/proxy/*` call and the host
 * UI's 10s poll — instead of once until setup first flips to complete (a
 * one-way transition; it never becomes incomplete again in a live install).
 *
 * Fix: restore the false→true memo for isSetupComplete (short-circuits so
 * isSetupComplete is never called again once true), and route
 * classifyLocalInstall through the same 5s cache `$lib/server/landing.ts`
 * already maintains for the launch-routing block (`_resetLaunchCache`),
 * rather than calling it fresh and uncached at this second call site.
 *
 * Both underlying lib functions are wrapped with call counters here so the
 * tests observe cache/memo behavior directly rather than inferring it from
 * timing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';

let isSetupCompleteCalls = 0;
let classifyLocalInstallCalls = 0;

vi.mock('@openpalm/lib', async (orig) => {
  const actual = await orig<typeof import('@openpalm/lib')>();
  return {
    ...actual,
    isSetupComplete: (...args: Parameters<typeof actual.isSetupComplete>) => {
      isSetupCompleteCalls++;
      return actual.isSetupComplete(...args);
    },
    classifyLocalInstall: (...args: Parameters<typeof actual.classifyLocalInstall>) => {
      classifyLocalInstallCalls++;
      return actual.classifyLocalInstall(...args);
    },
  };
});
vi.mock('$lib/server/endpoints.js', async (orig) => ({
  ...(await orig<typeof import('$lib/server/endpoints.js')>()),
  listRemoteStatuses: vi.fn(async () => []),
}));

import { handle, _resetLaunchCache, _resetSetupCompleteMemo } from './hooks.server.js';

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'knowledge', 'env');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

function makeEvent(path: string): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = { host: 'localhost:3880', accept: 'application/json' };
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

describe('hooks.server — setup-complete memo + launch-cache reuse (review 2026-07-10 K3)', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-setup-memo-'));
    process.env.OP_HOME = home;
    _resetLaunchCache();
    _resetSetupCompleteMemo();
    isSetupCompleteCalls = 0;
    classifyLocalInstallCalls = 0;
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('isSetupComplete is never called again once it has returned true (memo short-circuits)', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);

    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(isSetupCompleteCalls).toBe(1);

    seedStackEnv(state.stackDir, true); // flips to complete on disk
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(isSetupCompleteCalls).toBe(2); // called once more — sees true, memo latches

    // Revert the disk state back to incomplete. A live install never goes
    // backwards, but this proves the memo — not a fresh disk read — is now
    // authoritative: isSetupComplete must NOT be invoked a third time.
    seedStackEnv(state.stackDir, false);
    await handle({ event: makeEvent('/api/host/health'), resolve });
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(isSetupCompleteCalls).toBe(2);
  });

  test('classifyLocalInstall is cached for 5s across requests (shared with the launch-routing cache)', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);

    await handle({ event: makeEvent('/api/host/health'), resolve });
    const afterFirst = classifyLocalInstallCalls;
    expect(afterFirst).toBeGreaterThan(0);

    // Repeated requests within the cache window must not re-invoke it.
    await handle({ event: makeEvent('/api/host/health'), resolve });
    await handle({ event: makeEvent('/proxy/assistant/health'), resolve });
    expect(classifyLocalInstallCalls).toBe(afterFirst);

    // Busting the shared cache (as the 5s expiry eventually does) allows a
    // fresh read again.
    _resetLaunchCache();
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(classifyLocalInstallCalls).toBeGreaterThan(afterFirst);
  });
});
