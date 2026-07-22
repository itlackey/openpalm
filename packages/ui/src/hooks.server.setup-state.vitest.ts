/**
 * Setup completion is app-written state and can change while the UI process is
 * running (setup rerun, uninstall, recovery). The request guard must observe
 * the current state rather than permanently latching the first true value.
 * classifyLocalInstall still uses the shared 5s launch cache because those
 * filesystem probes are independent of the security-sensitive setup gate.
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
vi.mock('$lib/server/opencode-target.js', async (orig) => ({
  ...(await orig<typeof import('$lib/server/opencode-target.js')>()),
  listRemoteStatuses: vi.fn(async () => []),
}));

import { handle, _resetLaunchCache } from './hooks.server.js';

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'knowledge', 'env');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

function makeEvent(path: string, host = 'localhost:3880', clientAddress = '127.0.0.1'): RequestEvent {
  const url = new URL(`http://${host}${path}`);
  const headers: Record<string, string> = { host, accept: 'application/json' };
  return {
    url,
    request: new Request(url.toString(), { headers }),
    params: {},
    locals: {} as App.Locals,
    route: { id: path },
    platform: undefined,
    getClientAddress: () => clientAddress,
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

const resolve = () => Promise.resolve(new Response('ok', { status: 200 }));

describe('hooks.server — setup-state freshness + launch-cache reuse', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-setup-memo-'));
    process.env.OP_HOME = home;
    _resetLaunchCache();
    isSetupCompleteCalls = 0;
    classifyLocalInstallCalls = 0;
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    delete process.env.OP_ALLOW_REMOTE_SETUP;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('isSetupComplete is read on every request so app-written state changes take effect', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);

    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(isSetupCompleteCalls).toBe(1);

    seedStackEnv(state.stackDir, true); // flips to complete on disk
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(isSetupCompleteCalls).toBe(2);

    // Recovery/uninstall can move the app back to incomplete without restarting
    // the UI process. The request guard must observe that transition.
    seedStackEnv(state.stackDir, false);
    await handle({ event: makeEvent('/api/host/health'), resolve });
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(isSetupCompleteCalls).toBe(4);
  });

  test('classifyLocalInstall is cached for 5s across requests (shared with the launch-routing cache)', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);

    await handle({ event: makeEvent('/api/host/health'), resolve });
    const afterFirst = classifyLocalInstallCalls;
    expect(afterFirst).toBeGreaterThan(0);

    // Repeated requests within the cache window must not re-invoke it.
    await handle({ event: makeEvent('/api/host/health'), resolve });
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(classifyLocalInstallCalls).toBe(afterFirst);

    // Busting the shared cache (as the 5s expiry eventually does) allows a
    // fresh read again.
    _resetLaunchCache();
    await handle({ event: makeEvent('/api/host/health'), resolve });
    expect(classifyLocalInstallCalls).toBeGreaterThan(afterFirst);
  });

  test('first-run setup stays loopback-only when remote UI access is enabled', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);
    delete process.env.OP_ENABLE_ADMIN;
    process.env.OP_ALLOW_REMOTE_SETUP = '1';

    const response = await handle({
      event: makeEvent('/api/setup/complete', 'pwa.example', '127.0.0.1'),
      resolve,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'setup_localhost_only' });
  });
});
