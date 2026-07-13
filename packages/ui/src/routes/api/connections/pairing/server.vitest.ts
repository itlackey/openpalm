/**
 * Tests for POST /api/connections/pairing — host-minted QR/one-time pairing
 * code (#511 D3/D4/D6).
 *
 * Mirrors the sibling ../server.vitest.ts harness: computed-specifier dynamic
 * import so svelte-check stays green while the route module does not exist
 * yet (RED reason for every test below), temp-OP_HOME via
 * resetState/trackDir, stubbed global.fetch for the guardian admin call
 * (idiom: routes/api/host/versions/releases/server.vitest.ts).
 *
 * Contract under test (spec §2 T3, §3 packages/ui):
 *  - Capability guard is `host:stack:write` (D6), NOT `connections:manage` —
 *    minting writes a principal into the LOCAL stack's guardian, a
 *    host-stack mutation only electron-host/host-ui expose.
 *  - Double guard: capability check (403) + admin session/origin via
 *    withAdminBody (401), same as sibling /api/connections writes.
 *  - Delegates minting to @openpalm/lib's mintDirectPrincipalPairingCode —
 *    this route is a thin transport wrapper (sveltekit-rules §1.1).
 *  - Never persists or logs the minted secret: the response body's only
 *    secret-bearing field is `code`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { writeSecret, removeSecretFile, decodePairingCode } from '@openpalm/lib';
import { cleanupTempDirs, resetState, seedSecretsEnv, trackDir } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type PairingRouteModule = { POST: RouteHandler };

/**
 * RED-state-safe loader: the computed specifier keeps svelte-check green
 * while routes/api/connections/pairing/+server.ts does not exist yet.
 */
async function loadRoute(): Promise<PairingRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as PairingRouteModule;
}

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-pairing-route-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makePairingPostEvent(body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/connections/pairing');
  return {
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-pairing-mint',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { role: 'admin' },
    route: { id: '/api/connections/pairing' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

/**
 * A pairing POST event with caller-controlled raw body + extra headers, for the
 * body-parse / origin contract cases (PR #564 retest P3-2). Unlike
 * makePairingPostEvent it does not JSON.stringify — the caller supplies the
 * exact bytes (or a bad content-length) the route must reject.
 */
function makeRawPairingEvent(rawBody: string, extraHeaders: Record<string, string> = {}): unknown {
  const url = new URL('http://127.0.0.1:3880/api/connections/pairing');
  return {
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        cookie: 'op_session=admin-token',
        'x-request-id': 'req-pairing-mint',
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: rawBody,
    }),
    params: {},
    locals: { role: 'admin' },
    route: { id: '/api/connections/pairing' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

/** Stub the guardian admin listener's POST /admin/principals response. */
function stubGuardianAdmin(status: number, body: unknown = { principal: { id: 'device-ab12' } }): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const originalFetch = globalThis.fetch;

const ENV_KEYS = ['OP_UI_HOST_MODE', 'OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN', 'OP_HOME'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OP_HOME = makeTempHome();
  process.env.OP_UI_HOST_MODE = 'host-ui';
  resetState('admin-token');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  cleanupTempDirs();
});

describe('POST /api/connections/pairing — mint (#511 D3/D4)', () => {
  test('mints a direct principal and returns code + qrSvg + principalId', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    const fetchStub = stubGuardianAdmin(200, { principal: { id: 'device-ab12' } });

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      code: string;
      principalId: string;
      qrSvg: string;
      warnings: string[];
    };
    expect(typeof body.code).toBe('string');
    expect(body.principalId).toBeTruthy();
    expect(body.qrSvg.startsWith('<svg')).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);

    const decoded = decodePairingCode(body.code);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('expected decodable code');
    expect(decoded.payload.url).toBe('https://gw.example.ts.net/oc');
    expect(decoded.payload.label).toBe('My Phone');

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer /);
    const sentBody = JSON.parse(String(init.body)) as { kind: string };
    expect(sentBody.kind).toBe('direct');
  });

  test('403 in a mode without host:stack:write (pwa-static)', async () => {
    process.env.OP_UI_HOST_MODE = 'pwa-static';
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('capability_not_available');
  });

  test('401 without an admin session', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('400 for an invalid or non-http(s) URL', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    const fetchStub = stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'not a url' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_connection');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('400 for an over-long label (rejected before minting a principal) — PR #564 r3566891768', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    const fetchStub = stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(
      makePairingPostEvent({ label: 'x'.repeat(300), url: 'https://gw.example.ts.net/oc' }),
    );
    expect(res.status).toBe(400);
    // The principal must NOT be minted for an over-long label — otherwise a
    // downstream renderSVG overflow would orphan a durable guardian principal.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('502 with an actionable error when the guardian admin listener is unreachable', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? '').toMatch(/guardian admin|stack/i);
  });

  test('500 with an actionable error when op_guardian_admin_token is missing', async () => {
    // resetState()'s ensureSecrets() auto-provisions op_guardian_admin_token
    // as part of normal state bootstrap (mirrors real app-startup behavior,
    // packages/lib/src/control-plane/secrets.ts:156) — remove it explicitly
    // to simulate the fail-closed scenario this test targets (test-only
    // deviation from the spec's literal "no writeSecret() call" phrasing;
    // recorded in the #511 implementer report).
    removeSecretFile(getState().homeDir, 'op_guardian_admin_token');
    const fetchStub = stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? '').toMatch(/op_guardian_admin_token/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('warns when GUARDIAN_DIRECT_INGRESS is not enabled', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    seedSecretsEnv(getState().homeDir, 'OP_SETUP_COMPLETE=true\n');
    stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => /GUARDIAN_DIRECT_INGRESS/.test(w))).toBe(true);
  });

  test('empties the GUARDIAN_DIRECT_INGRESS warning once the env is enabled', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    seedSecretsEnv(getState().homeDir, 'GUARDIAN_DIRECT_INGRESS=true\n');
    stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => /GUARDIAN_DIRECT_INGRESS/.test(w))).toBe(false);
  });

  test('warns for a plain-http non-loopback guardian URL', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    seedSecretsEnv(getState().homeDir, 'GUARDIAN_DIRECT_INGRESS=true\n');
    stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'http://192.168.1.5:3830' }));
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => /https/i.test(w))).toBe(true);
  });

  test('does not warn about HTTPS for a loopback http:// guardian URL', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    seedSecretsEnv(getState().homeDir, 'GUARDIAN_DIRECT_INGRESS=true\n');
    stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'http://127.0.0.1:3830' }));
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => /https/i.test(w))).toBe(false);
  });

  test('400 invalid_json for a JSON null body (must not reach body.label as a 500)', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    const fetchStub = stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makeRawPairingEvent('null'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_json');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('400 for a guardian URL carrying a query string (breaks path concatenation)', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    const fetchStub = stubGuardianAdmin(200);

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example?tenant=home' }));
    expect(res.status).toBe(400);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('never persists or logs the minted secret', async () => {
    writeSecret(getState().homeDir, 'op_guardian_admin_token', 'f'.repeat(48));
    stubGuardianAdmin(200, { principal: { id: 'device-ab12' } });

    const { POST } = await loadRoute();
    const res = await POST(makePairingPostEvent({ label: 'My Phone', url: 'https://gw.example.ts.net/oc' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect('token' in body).toBe(false);
    expect('secret' in body).toBe(false);
  });
});
