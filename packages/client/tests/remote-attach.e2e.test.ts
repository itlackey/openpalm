/**
 * #486 D4 — end-to-end remote-attach verification.
 *
 * Closes the "each side tested in isolation only" gap: the guardian's own
 * suite (packages/guardian/src/proxy-direct.test.ts, cors.test.ts) exercises
 * the direct-tier `/oc/*` proxy against hand-rolled HTTP calls, and the
 * client's transport suite (tests/transport-*.test.ts) exercises
 * createTransport() against a mocked fetch — but nothing had driven the REAL
 * guardian with the REAL client transport together. This spawns the real
 * guardian as a subprocess (mirroring packages/guardian/src/proxy-direct
 * .test.ts) and drives it with the real createTransport from
 * ../src/lib/transport/index.js.
 *
 * Lives in packages/client/tests/ so it runs under the mandated
 * `bun run client:test` gate (per the #486 spec, not packages/guardian/ —
 * this is the CLIENT side of the contract).
 *
 * The browser-only 'blocked' CORS state cannot be reproduced under Bun (no
 * CORS enforcement outside a browser) — it stays covered by the existing
 * tests/transport-health-cors.test.ts unit suite. Test 27 below instead
 * asserts the guardian's raw CORS response headers for an allowlisted
 * Origin — the server half of the same contract.
 *
 * Tests 25/26/27 are VERIFICATION (may pass before the #486 D2 `probePath`
 * fix lands too — they exercise the already-shipped createSession/
 * sendMessage/subscribeEvents/CORS surface, not the new probePath option).
 *
 * Test 23 is genuinely RED pre-implementation: without `probePath`,
 * probeHealth() GETs the bare `/oc/` root, which is NOT allowlisted for a
 * direct principal (`GET /session` is) — the guardian's Gate 2 allowlist
 * check denies it 403 `forbidden_endpoint`, which probeHealth()'s existing
 * 401/403 -> 'unauthorized' mapping reports as `state: 'unauthorized'`
 * instead of the expected `'accessible'`.
 *
 * Tests 24 and 28, run against real guardian behavior, turn out to ALREADY
 * pass before the probePath fix lands (confirmed by running this suite
 * pre-implementation) — not true RED, despite the spec's RED annotation:
 *   - 24 (wrong secret): the guardian's authenticate() gate runs BEFORE the
 *     endpoint-allowlist gate (proxy.ts), so a bad Basic secret 401s
 *     regardless of which path is probed — root or /session.
 *   - 28 (GUARDIAN_DIRECT_INGRESS unset): the ingress-disabled short-circuit
 *     404s every /oc/* path before routing is even consulted, so probing the
 *     bare root already reports unreachable/HTTP 404 without probePath.
 * Both are kept as specified — they are still valid regression pins of the
 * post-implementation contract (D2's acceptance table cites them), just not
 * discriminating RED/GREEN on their own. Test 23 is the one that fails for
 * the intended reason, matching the spec's own framing ("This is the test
 * that fails for the intended reason").
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from '../src/lib/transport/index.ts';
import { OC_DOC_FIXTURE } from '../../guardian/src/oc-doc-fixture.ts';

const PRINCIPAL_ID = 'remote-attach-client';
const PRINCIPAL_SECRET = 'remote-attach-secret-8642';
const ADMIN_TOKEN = 'remote-attach-admin-token-8642';
const CLIENT_ORIGIN = 'http://127.0.0.1:3890';

const guardianRoot = resolve(fileURLToPath(new URL('../../guardian', import.meta.url)));

let guardianProc: Subprocess;
let mockAssistant: ReturnType<typeof Bun.serve>;
let tmpDir: string;
let directPort: number;
let adminPort: number;
let internalPort: number;
let directUrl: string;
let adminUrl: string;
/** SSE frames the mock assistant's GET /event endpoint streams (test-controlled). */
let eventFrames: string[] = [];

let sessionSeq = 0;
const sessions = new Map<string, { title: string }>();

function getAvailablePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const s = createServer();
    s.unref();
    s.once('error', rejectP);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        s.close();
        rejectP(new Error('no port'));
        return;
      }
      const { port } = addr;
      s.close((err) => (err ? rejectP(err) : resolveP(port)));
    });
  });
}

async function waitForGuardianReady(): Promise<void> {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (guardianProc.exitCode !== null) {
      throw new Error(`guardian exited before ready with code ${guardianProc.exitCode}`);
    }
    try {
      const resp = await fetch(`${directUrl}/health`);
      if (resp.ok) { ready = true; break; }
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error('guardian did not become ready');

  // Wait for the boot-time drift guard to enable the /oc/* proxy.
  let proxyOn = false;
  const internalUrl = `http://127.0.0.1:${internalPort}`;
  for (let i = 0; i < 50; i++) {
    const resp = await fetch(`${internalUrl}/stats`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    if (resp.ok && (await resp.json()).oc_proxy?.enabled === true) { proxyOn = true; break; }
    await Bun.sleep(100);
  }
  if (!proxyOn) throw new Error('guardian /oc proxy did not enable (drift guard)');
}

async function seedDirectPrincipal(): Promise<void> {
  const resp = await fetch(`${adminUrl}/admin/principals`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: PRINCIPAL_ID, kind: 'direct', token: PRINCIPAL_SECRET, label: 'Remote-attach e2e client' }),
  });
  if (!resp.ok) throw new Error(`admin seed failed: ${resp.status} ${await resp.text()}`);
}

beforeAll(async () => {
  const assistantPort = await getAvailablePort();
  internalPort = await getAvailablePort();
  directPort = await getAvailablePort();
  adminPort = await getAvailablePort();
  const deadModerationPort = await getAvailablePort(); // nothing listens here

  tmpDir = mkdtempSync(join(tmpdir(), 'remote-attach-e2e-'));
  const adminTokenPath = join(tmpDir, 'admin-token');
  writeFileSync(adminTokenPath, `${ADMIN_TOKEN}\n`);

  mockAssistant = Bun.serve({
    port: assistantPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/doc' && req.method === 'GET') {
        return Response.json(OC_DOC_FIXTURE);
      }
      if (url.pathname === '/session' && req.method === 'POST') {
        await req.json().catch(() => null);
        sessionSeq += 1;
        const id = `ses_${sessionSeq}`;
        sessions.set(id, { title: '' });
        return Response.json({ id });
      }
      if (url.pathname === '/session' && req.method === 'GET') {
        return Response.json([...sessions.entries()].map(([id, s]) => ({ id, title: s.title })));
      }
      if (url.pathname.startsWith('/session/') && url.pathname.endsWith('/message') && req.method === 'POST') {
        const id = url.pathname.split('/')[2];
        return Response.json({ parts: [{ type: 'text', text: `answer from ${id}` }] });
      }
      if (url.pathname === '/event' && req.method === 'GET') {
        // Model a real assistant /event stream: flush queued frames and stay
        // open until the client disconnects — never self-terminate (mirrors
        // packages/guardian/src/proxy.test.ts's mock).
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const sent = new Set<string>();
            while (!req.signal.aborted) {
              for (const f of eventFrames) {
                if (sent.has(f)) continue;
                sent.add(f);
                try { controller.enqueue(enc.encode(`data: ${f}\n\n`)); }
                catch { return; }
              }
              await Bun.sleep(10);
            }
            try { controller.close(); } catch { /* already closed */ }
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname.startsWith('/session/') && req.method === 'GET') {
        const id = url.pathname.split('/')[2];
        return Response.json({ id, title: sessions.get(id)?.title ?? '' });
      }
      return new Response('not found', { status: 404 });
    },
  });

  guardianProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: guardianRoot,
    env: {
      ...process.env,
      PORT: String(internalPort),
      GUARDIAN_DIRECT_PORT: String(directPort),
      GUARDIAN_ADMIN_PORT: String(adminPort),
      GUARDIAN_DIRECT_INGRESS: 'true',
      GUARDIAN_CORS_ALLOWED_ORIGINS: CLIENT_ORIGIN,
      GUARDIAN_STATE_DB_PATH: join(tmpDir, 'state.db'),
      GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
      GUARDIAN_INTERNAL_HOST: '127.0.0.1',
      OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
      GUARDIAN_AUDIT_PATH: join(tmpDir, 'audit.log'),
      // Content validation stays off by default (unset), but point at a dead
      // port defensively in case an ambient env enables it — fail-closed,
      // never a hang.
      GUARDIAN_MODERATION_URL: `http://127.0.0.1:${deadModerationPort}`,
      GUARDIAN_MODERATION_TIMEOUT_MS: '500',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  directUrl = `http://127.0.0.1:${directPort}`;
  adminUrl = `http://127.0.0.1:${adminPort}`;
  await waitForGuardianReady();
  await seedDirectPrincipal();
}, 30_000);

afterAll(() => {
  guardianProc?.kill();
  mockAssistant?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('remote-attach e2e (#486 D4) — probeHealth against the real guardian', () => {
  test('probeHealth with probePath /session and the minted principal reports accessible', async () => {
    const transport = createTransport({
      baseUrl: `${directUrl}/oc`,
      probePath: '/session',
      auth: { mode: 'basic', username: PRINCIPAL_ID, password: PRINCIPAL_SECRET },
    } as Parameters<typeof createTransport>[0]);
    const result = await transport.probeHealth();
    expect(result.state).toBe('accessible');
  });

  test('probeHealth with a wrong secret reports unauthorized', async () => {
    const transport = createTransport({
      baseUrl: `${directUrl}/oc`,
      probePath: '/session',
      auth: { mode: 'basic', username: PRINCIPAL_ID, password: 'wrong-secret' },
    } as Parameters<typeof createTransport>[0]);
    const result = await transport.probeHealth();
    expect(result.state).toBe('unauthorized');
  });
});

describe('remote-attach e2e (#486 D4) — session + message round-trip (verification)', () => {
  test('createSession + sendMessage round-trip through the guardian /oc proxy', async () => {
    const transport = createTransport({
      baseUrl: `${directUrl}/oc`,
      auth: { mode: 'basic', username: PRINCIPAL_ID, password: PRINCIPAL_SECRET },
    });
    const session = await transport.createSession();
    expect(typeof session.id).toBe('string');
    const response = await transport.sendMessage(session.id, 'hello from the e2e client');
    expect(response).toMatchObject({ parts: [{ type: 'text', text: `answer from ${session.id}` }] });
  });
});

describe('remote-attach e2e (#486 D4) — SSE stream (verification)', () => {
  test('subscribeEvents streams /oc/event SSE frames end-to-end', async () => {
    const transport = createTransport({
      baseUrl: `${directUrl}/oc`,
      auth: { mode: 'basic', username: PRINCIPAL_ID, password: PRINCIPAL_SECRET },
    });
    // Own a session first — the guardian's /event fan-out only forwards
    // frames whose sessionID this principal owns (§3.2 hard drop rule).
    const session = await transport.createSession();
    eventFrames = [
      JSON.stringify({ type: 'session.idle', properties: { sessionID: session.id } }),
    ];

    const received: unknown[] = [];
    const gotEvent = new Promise<void>((resolveEvent) => {
      const unsubscribe = transport.subscribeEvents({
        onEvent: (event) => {
          received.push(event);
          if (received.length >= 1) {
            unsubscribe();
            resolveEvent();
          }
        },
      });
    });

    await Promise.race([
      gotEvent,
      new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('timed out waiting for an SSE event')), 5000)),
    ]);

    expect(received.length).toBeGreaterThanOrEqual(1);
    eventFrames = [];
  }, 10_000);
});

describe('remote-attach e2e (#486 D4) — CORS (verification of the D3 provisioning contract)', () => {
  test('responses to an allowlisted browser Origin carry access-control-allow-origin', async () => {
    const auth = `Basic ${Buffer.from(`${PRINCIPAL_ID}:${PRINCIPAL_SECRET}`, 'utf-8').toString('base64')}`;
    const resp = await fetch(`${directUrl}/oc/session`, {
      method: 'GET',
      headers: { authorization: auth, origin: CLIENT_ORIGIN },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBe(CLIENT_ORIGIN);
  });
});

describe('remote-attach e2e (#486 D4) — ingress-off remediation (D2 404 state)', () => {
  test('a guardian with GUARDIAN_DIRECT_INGRESS unset answers 404 and probeHealth reports unreachable HTTP 404', async () => {
    const offInternalPort = await getAvailablePort();
    const offDirectPort = await getAvailablePort();
    const offAdminPort = await getAvailablePort();
    const offTmpDir = mkdtempSync(join(tmpdir(), 'remote-attach-e2e-off-'));
    const offAdminTokenPath = join(offTmpDir, 'admin-token');
    writeFileSync(offAdminTokenPath, `${ADMIN_TOKEN}\n`);

    const offProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
      cwd: guardianRoot,
      env: {
        ...process.env,
        PORT: String(offInternalPort),
        GUARDIAN_DIRECT_PORT: String(offDirectPort),
        GUARDIAN_ADMIN_PORT: String(offAdminPort),
        GUARDIAN_DIRECT_INGRESS: 'false',
        GUARDIAN_STATE_DB_PATH: join(offTmpDir, 'state.db'),
        GUARDIAN_ADMIN_TOKEN_FILE: offAdminTokenPath,
        GUARDIAN_INTERNAL_HOST: '127.0.0.1',
        OP_ASSISTANT_URL: `http://127.0.0.1:${await getAvailablePort()}`,
        GUARDIAN_AUDIT_PATH: join(offTmpDir, 'audit.log'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const offDirectUrl = `http://127.0.0.1:${offDirectPort}`;
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if (offProc.exitCode !== null) throw new Error(`guardian (ingress off) exited: ${offProc.exitCode}`);
        try {
          const resp = await fetch(`${offDirectUrl}/health`);
          if (resp.ok) { ready = true; break; }
        } catch { /* not ready */ }
        await Bun.sleep(100);
      }
      if (!ready) throw new Error('guardian (ingress off) did not become ready');

      const transport = createTransport({
        baseUrl: `${offDirectUrl}/oc`,
        probePath: '/session',
        auth: { mode: 'basic', username: PRINCIPAL_ID, password: PRINCIPAL_SECRET },
      } as Parameters<typeof createTransport>[0]);
      const result = await transport.probeHealth();
      expect(result.state).toBe('unreachable');
      expect(result.detail).toBe('HTTP 404');
    } finally {
      offProc.kill();
      try { rmSync(offTmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 15_000);
});
