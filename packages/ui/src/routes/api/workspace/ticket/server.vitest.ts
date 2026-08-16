/**
 * POST /api/workspace/ticket — the one place a workspace ticket is handed out.
 *
 * The ticket carries this browser's session to a workspace published on another
 * hostname, so the only thing that matters here is that it is never handed to
 * someone who does not already have that session. What a ticket IS (single use,
 * one minute, same signed token) is pinned in lib/server/workspace-ticket.vitest.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { redeemWorkspaceTicket } from '$lib/server/workspace-ticket.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;

function makeEvent(token: string | null = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/workspace/ticket');
  return {
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-workspace-ticket',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/workspace/ticket' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

const ENV_KEYS = ['OP_HOME', 'OP_UI_LOGIN_PASSWORD'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const homeDir = join(tmpdir(), `openpalm-workspace-ticket-${randomBytes(4).toString('hex')}`);
  mkdirSync(homeDir, { recursive: true });
  process.env.OP_HOME = trackDir(homeDir);
  resetState('admin-token');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  cleanupTempDirs();
});

describe('POST /api/workspace/ticket', () => {
  test('a signed-in browser gets a ticket that the listener will redeem', async () => {
    const { POST } = (await import('./+server.js')) as { POST: RouteHandler };
    const res = await POST(makeEvent());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket?: string; expiresInMs?: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.expiresInMs).toBe(60_000);
    expect(redeemWorkspaceTicket(body.ticket ?? '')).toBe(true);
  });

  test('401 without a session — a ticket IS the session, so this is the boundary', async () => {
    const { POST } = (await import('./+server.js')) as { POST: RouteHandler };
    const res = await POST(makeEvent(null));

    expect(res.status).toBe(401);
  });

  test('401 for a forged cookie', async () => {
    const { POST } = (await import('./+server.js')) as { POST: RouteHandler };
    const res = await POST(makeEvent('not-the-token'));

    expect(res.status).toBe(401);
  });
});
