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

import { handle, _resetLaunchCache } from './hooks.server.js';

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'state');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

function makeEvent(
  path: string,
  host = 'localhost:3880',
  clientAddress = '127.0.0.1',
  method = 'GET',
  token?: string,
): RequestEvent {
  const url = new URL(`http://${host}${path}`);
  const headers: Record<string, string> = { host, accept: 'application/json' };
  if (token) headers.cookie = `op_session=${token}`;
  return {
    url,
    request: new Request(url.toString(), { headers, method }),
    params: {},
    locals: {} as App.Locals,
    route: { id: path },
    platform: undefined,
    getClientAddress: () => clientAddress,
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

function makeDocumentEvent(path: string): RequestEvent {
  const event = makeEvent(path);
  event.request = new Request(event.url, {
    headers: { host: 'localhost:3880', accept: 'text/html' },
  });
  return event;
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
    process.env.OP_ALLOW_REMOTE_SETUP = '1';

    const response = await handle({
      event: makeEvent('/api/setup/complete', 'localhost:3880', '192.168.1.20'),
      resolve,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'setup_localhost_only' });
  });

  test('fresh non-host processes cannot render setup or mutate setup APIs', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);
    delete process.env.OP_ENABLE_ADMIN;

    const pageResponse = await handle({ event: makeDocumentEvent('/setup'), resolve });
    expect(pageResponse.status).toBe(403);
    expect(await pageResponse.json()).toMatchObject({
      error: 'capability_not_available',
      details: { capability: 'host:setup' },
    });

    const apiResponse = await handle({
      event: makeEvent('/api/setup/complete', 'localhost:3880', '127.0.0.1', 'POST'),
      resolve,
    });
    expect(apiResponse.status).toBe(403);
    expect(await apiResponse.json()).toMatchObject({
      error: 'capability_not_available',
      details: { capability: 'host:setup' },
    });

    const readResponse = await handle({ event: makeEvent('/api/setup/system-check'), resolve });
    expect(readResponse.status).toBe(403);
    expect(await readResponse.json()).toMatchObject({ error: 'capability_not_available' });
  });

  test('installed non-host processes remain unable to use setup even with an admin session', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);
    delete process.env.OP_ENABLE_ADMIN;
    _resetLaunchCache();

    const pageEvent = makeDocumentEvent('/setup?rerun=1');
    pageEvent.request = new Request(pageEvent.url, {
      headers: {
        host: 'localhost:3880',
        accept: 'text/html',
        cookie: 'op_session=test-admin-pw',
      },
    });
    const pageResponse = await handle({ event: pageEvent, resolve });
    expect(pageResponse.status).toBe(403);

    const apiResponse = await handle({
      event: makeEvent(
        '/api/setup/retry-deploy',
        'localhost:3880',
        '127.0.0.1',
        'POST',
        'test-admin-pw',
      ),
      resolve,
    });
    expect(apiResponse.status).toBe(403);
    expect(await apiResponse.json()).toMatchObject({ error: 'capability_not_available' });
  });

  test('host-capable processes can use fresh setup and authenticated installed setup', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);

    expect((await handle({ event: makeDocumentEvent('/setup'), resolve })).status).toBe(200);
    expect((await handle({
      event: makeEvent('/api/setup/complete', 'localhost:3880', '127.0.0.1', 'POST'),
      resolve,
    })).status).toBe(200);
    expect((await handle({ event: makeEvent('/api/setup/system-check'), resolve })).status).toBe(200);

    seedStackEnv(state.stackDir, true);
    _resetLaunchCache();
    const pageEvent = makeDocumentEvent('/setup?rerun=1');
    pageEvent.request = new Request(pageEvent.url, {
      headers: {
        host: 'localhost:3880',
        accept: 'text/html',
        cookie: 'op_session=test-admin-pw',
      },
    });
    expect((await handle({ event: pageEvent, resolve })).status).toBe(200);
    expect((await handle({
      event: makeEvent(
        '/api/setup/retry-deploy',
        'localhost:3880',
        '127.0.0.1',
        'POST',
        'test-admin-pw',
      ),
      resolve,
    })).status).toBe(200);
  });

  test('setup status and health remain public in a fresh non-host process', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, false);
    delete process.env.OP_ENABLE_ADMIN;

    expect((await handle({ event: makeEvent('/api/setup/status'), resolve })).status).toBe(200);
    expect((await handle({ event: makeEvent('/health'), resolve })).status).toBe(200);
    expect((await handle({ event: makeEvent('/guardian/health'), resolve })).status).toBe(200);
  });

  test('completed setup reruns redirect unauthenticated document requests to login', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);
    _resetLaunchCache();

    await expect(handle({ event: makeDocumentEvent('/setup?rerun=1'), resolve })).rejects.toMatchObject({
      location: '/login?redirectTo=%2Fsetup%3Frerun%3D1',
    });
  });

  test('completed setup APIs require admin except the public status endpoint', async () => {
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true);
    _resetLaunchCache();

    const protectedResponse = await handle({ event: makeEvent('/api/setup/system-check'), resolve });
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toMatchObject({ error: 'unauthorized' });

    const statusResponse = await handle({ event: makeEvent('/api/setup/status'), resolve });
    expect(statusResponse.status).toBe(200);
  });
});
