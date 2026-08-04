/**
 * The setup wizard is for machines that HOST a stack, and only those.
 *
 * `setup_incomplete` is supposed to mean "an install was started and not
 * finished", so pulling every navigation back to /setup is the right response.
 * But both harnesses re-seed the managed system/ tree on every launch, which
 * materializes core.compose.yml — the exact file classifyLocalInstall keys on —
 * so a machine that has installed nothing reads as setup_incomplete from its
 * first run onward.
 *
 * That made the wizard a trap for anyone using a REMOTE assistant: every
 * restart landed on a local-install wizard, and on a host without Docker that
 * wizard can be neither completed nor dismissed. The escape link appeared to
 * work only because client-side navigations carry no `Accept: text/html` and so
 * never reached the guard — a reload went straight back to /setup.
 *
 * The guard now reads whether the machine hosts a stack, which an install
 * records and a launch does not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { handle, _resetLaunchCache } from './hooks.server.js';

/**
 * The on-disk state a packaged launch leaves behind: the managed tree seeded,
 * an unfinished stack env, and no record that anyone asked to host anything.
 */
function seedHome(home: string, stackEnv: string): void {
  mkdirSync(join(home, 'system', 'stack'), { recursive: true });
  writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), stackEnv);
  _resetLaunchCache();
}

const NOT_HOSTING = 'OP_SETUP_COMPLETE=false\n';
const HOSTING = 'OP_SETUP_COMPLETE=false\nOP_HOST_ENABLED=true\n';

function makeDocumentEvent(path: string): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  return {
    url,
    request: new Request(url, { headers: { host: 'localhost:3880', accept: 'text/html' } }),
    params: {},
    locals: {} as App.Locals,
    cookies: { get: () => undefined },
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
    const thrown = err as { status?: number; location?: string };
    if (typeof thrown?.location === 'string') return thrown.location;
    throw err;
  }
}

describe('hooks.server — the wizard is for machines that host a stack', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-setup-escape-'));
    process.env.OP_HOME = home;
    resetState('test-admin-pw');
    _resetLaunchCache();
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_ENABLE_ADMIN;
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    _resetLaunchCache();
  });

  test('an unfinished install on a hosting machine is still pulled back to the wizard', async () => {
    seedHome(home, HOSTING);
    expect(await redirectTarget('/chat')).toBe('/setup');
  });

  test('a machine that hosts nothing is never pulled into it', async () => {
    seedHome(home, NOT_HOSTING);
    expect(await redirectTarget('/chat')).not.toBe('/setup');
    expect(await redirectTarget('/connections')).not.toBe('/setup');
    expect(await redirectTarget('/connections/new')).not.toBe('/setup');
  });

  // The durability the old client-hint version could not demonstrate: the
  // record is on disk, so a reload lands the same way rather than bouncing
  // back the moment a navigation carries `Accept: text/html`.
  test('and stays out of it across repeated document navigations', async () => {
    seedHome(home, NOT_HOSTING);
    expect(await redirectTarget('/chat')).not.toBe('/setup');
    _resetLaunchCache();
    expect(await redirectTarget('/chat')).not.toBe('/setup');
  });

  test('leaves /setup itself reachable — this exempts, it does not disable', async () => {
    seedHome(home, NOT_HOSTING);
    const response = await handle({ event: makeDocumentEvent('/setup'), resolve });
    expect(response.status).toBe(200);
  });

  // The record is a host fact, not a client hint: no cookie, header or query
  // string can turn a machine into a host or out of one.
  test('cannot be flipped by anything the browser sends', async () => {
    seedHome(home, HOSTING);
    const url = new URL('http://localhost:3880/chat');
    const event = {
      url,
      request: new Request(url, {
        headers: {
          host: 'localhost:3880',
          accept: 'text/html',
          cookie: 'op_has_connections=1; OP_HOST_ENABLED=false',
        },
      }),
      params: {},
      locals: {} as App.Locals,
      cookies: { get: (name: string) => (name === 'op_has_connections' ? '1' : undefined) },
      route: { id: '/chat' },
      platform: undefined,
      getClientAddress: () => '127.0.0.1',
      isDataRequest: false,
      isSubRequest: false,
    } as unknown as RequestEvent;

    try {
      const response = await handle({ event, resolve });
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.headers.get('location')).toBe('/setup');
    } catch (err) {
      expect((err as { location?: string }).location).toBe('/setup');
    }
  });
});
