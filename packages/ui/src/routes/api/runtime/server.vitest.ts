/**
 * Tests for GET /api/runtime — Phase 1 RuntimeContext v2 (issue #509).
 *
 * ALL RED until the implementation lands: routes/api/runtime/+server.ts does
 * not exist yet.
 *
 * Per plan §6.4 this endpoint is PUBLIC (no auth) and returns the
 * ServerRuntimeContext, including the contract version field that the future
 * hosted client uses as a version-skew handshake before enabling features.
 *
 * Asserts:
 *  - 200 with no session cookie (public — unlike every /admin/* endpoint)
 *  - 200 with a garbage session cookie (auth is never consulted)
 *  - JSON body carrying version: 2 and the full ServerRuntimeContext shape
 *  - admin reflects the env mapping (OP_INSIDE_ELECTRON / OP_ENABLE_ADMIN)
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET } from './+server.js';

function makeEvent(headers: Record<string, string> = {}) {
  const url = new URL('http://127.0.0.1:3880/api/runtime');
  return {
    url,
    request: new Request(url, { headers }),
    params: {},
    locals: {},
    route: { id: '/api/runtime' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as Parameters<typeof GET>[0];
}

const MODE_ENV_KEYS = ['OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of MODE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODE_ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});

describe('GET /api/runtime — public runtime-context endpoint (plan §6.4)', () => {
  test('returns 200 with no session cookie (no auth required)', async () => {
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
  });

  test('returns 200 with a garbage session cookie (auth is never consulted)', async () => {
    const res = await GET(makeEvent({ cookie: 'op_session=not-a-real-token' }));
    expect(res.status).toBe(200);
  });

  test('responds with JSON', async () => {
    const res = await GET(makeEvent());
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  test('body carries the contract version (2) for the hosted-client handshake', async () => {
    const res = await GET(makeEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe(2);
  });

  test('body exposes the ServerRuntimeContext shape (plan §6.1)', async () => {
    const res = await GET(makeEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.serverCapabilities)).toBe(true);
    expect(body.serverCapabilities).toContain('chat');
    expect(typeof body.admin).toBe('boolean');
    expect(typeof body.publicBaseUrl).toBe('string');
    expect(typeof body.uiVersion).toBe('string');
    expect(typeof body.skeletonVersion).toBe('string');
    expect(body.routes).toBeTypeOf('object');
    expect(body.security).toBeTypeOf('object');
  });

  test('admin reflects OP_INSIDE_ELECTRON=1 → true', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const res = await GET(makeEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.admin).toBe(true);
  });

  test('admin is false when no admin env is set (served baseline)', async () => {
    const res = await GET(makeEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.admin).toBe(false);
  });
});
