/**
 * An unfinished local install must not trap a browser that has its own
 * connections.
 *
 * `setup_incomplete` is supposed to mean "an install was started and not
 * finished", and pulling every navigation back to /setup is the right response
 * to that. But a packaged desktop build re-seeds the managed system/ tree on
 * every launch, which materializes core.compose.yml — the exact file
 * classifyLocalInstall keys on — so a machine that has installed nothing reads
 * as setup_incomplete from its first run onward.
 *
 * The result was a hard trap for anyone using a REMOTE assistant: every
 * restart landed on a local-install wizard, and on a host without Docker that
 * wizard can be neither completed nor dismissed. The in-app "connect instead"
 * link appeared to work only because client-side navigations carry no
 * `Accept: text/html` and so never reached the guard — a reload went straight
 * back to /setup.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { handle, _resetLaunchCache } from './hooks.server.js';

/** The on-disk state a packaged launch leaves behind: seeded, never installed. */
function seedSeededButNotInstalledHome(home: string): void {
  mkdirSync(join(home, 'system', 'stack'), { recursive: true });
  writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=false\n');
}

function makeDocumentEvent(path: string, cookies: Record<string, string> = {}): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  return {
    url,
    request: new Request(url, { headers: { host: 'localhost:3880', accept: 'text/html' } }),
    params: {},
    locals: {} as App.Locals,
    cookies: { get: (name: string) => cookies[name] },
    route: { id: path },
    platform: undefined,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

const resolve = () => Promise.resolve(new Response('ok', { status: 200 }));

/** Follow `handle`, returning the redirect Location or null for a real response. */
async function redirectTarget(
  path: string,
  cookies: Record<string, string> = {},
): Promise<string | null> {
  try {
    const response = await handle({ event: makeDocumentEvent(path, cookies), resolve });
    return response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null;
  } catch (err) {
    const thrown = err as { status?: number; location?: string };
    if (typeof thrown?.location === 'string') return thrown.location;
    throw err;
  }
}

const WITH_CONNECTIONS = { op_has_connections: '1' };

describe('hooks.server — an unfinished install does not trap a browser with connections', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    process.env.PORT = '3880';
    process.env.OP_ENABLE_ADMIN = '1';
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-setup-escape-'));
    process.env.OP_HOME = home;
    resetState('test-admin-pw');
    seedSeededButNotInstalledHome(home);
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

  test('still pulls a browser with no connections into the wizard', () => {
    return expect(redirectTarget('/chat')).resolves.toBe('/setup');
  });

  test('lets a browser with connections reach chat', async () => {
    expect(await redirectTarget('/chat', WITH_CONNECTIONS)).not.toBe('/setup');
  });

  test('lets it reach the connection manager, so the escape link survives a reload', async () => {
    expect(await redirectTarget('/connections', WITH_CONNECTIONS)).not.toBe('/setup');
    expect(await redirectTarget('/connections/new', WITH_CONNECTIONS)).not.toBe('/setup');
  });

  test('leaves /setup itself reachable — this exempts, it does not disable', async () => {
    const response = await handle({
      event: makeDocumentEvent('/setup', WITH_CONNECTIONS),
      resolve,
    });
    expect(response.status).toBe(200);
  });

  // The hint chooses between usage surfaces; it is not an authorization. Any
  // real boundary (the setup capability gate, its localhost restriction, every
  // /api/host/* route) is enforced elsewhere and unaffected.
  test('an unrelated cookie value does not count as connections', async () => {
    expect(await redirectTarget('/chat', { op_has_connections: 'maybe' })).toBe('/setup');
  });
});
