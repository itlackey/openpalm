import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OC_DOC_FIXTURE } from './oc-doc-fixture';
import { handleInternalRequest } from './server';
import { _setProxyEnabledForTest } from './drift';
import { initializePrincipalStore, seedPortalPrincipalsFromEnv } from './state-db';

const TEST_SECRET = 'test-secret-value-1234';
const TEST_PRINCIPAL = 'test';

// IN-PROCESS: the guardian's config (assistant URL, db path, flags) is now read
// lazily, so we drive `handleInternalRequest` directly with a Request — no
// `bun run src/server.ts` subprocess, no ports to bind, no readiness polling, no
// leaked processes. The only real server is the mock upstream assistant.
let mockAssistantServer: ReturnType<typeof Bun.serve>;
let tmpDir: string;
let assistantPort = 0;
let sessionCreateCount = 0;
let messageCount = 0;
let lastCreateBody: unknown = null;

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to resolve test port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function authorization(secret = TEST_SECRET, principalId = TEST_PRINCIPAL): string {
  return `Basic ${Buffer.from(`${principalId}:${secret}`, 'utf-8').toString('base64')}`;
}

/** Call the internal listener's handler directly (in-process, no HTTP server). */
function internal(path: string, init: RequestInit = {}): Promise<Response> {
  return handleInternalRequest(new Request(`http://guardian${path}`, init));
}

function ocCall(
  path: string,
  init: RequestInit = {},
  opts: { userId?: string; sessionKey?: string; secret?: string; principalId?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', authorization(opts.secret, opts.principalId));
  if (opts.userId) headers.set('x-openpalm-user', opts.userId);
  if (opts.sessionKey) headers.set('x-openpalm-session-key', opts.sessionKey);
  return internal(`/oc${path}`, { ...init, headers });
}

function startMockAssistant(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: assistantPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/doc' && req.method === 'GET') {
        return Response.json(OC_DOC_FIXTURE);
      }
      if (url.pathname === '/session' && req.method === 'POST') {
        sessionCreateCount += 1;
        lastCreateBody = await req.json().catch(() => null);
        return Response.json({ id: `mock-session-${sessionCreateCount}` });
      }
      if (url.pathname === '/session' && req.method === 'GET') {
        return Response.json([]);
      }
      if (url.pathname.startsWith('/session/') && url.pathname.endsWith('/message') && req.method === 'POST') {
        messageCount += 1;
        const sessionId = url.pathname.split('/')[2] ?? 'unknown-session';
        return Response.json({ parts: [{ type: 'text', text: `mock answer from ${sessionId}` }] });
      }
      if (url.pathname === '/event' && req.method === 'GET') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 'mock-session-1', messageID: '^msg1', delta: 'mock answer from mock-session-1' } })}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'mock-session-1' } })}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
}

beforeAll(async () => {
  assistantPort = await getAvailablePort();
  tmpDir = mkdtempSync(join(tmpdir(), 'guardian-test-'));
  const secretPath = join(tmpDir, 'test-secret');
  writeFileSync(secretPath, `${TEST_SECRET}\n`);

  // The DB path comes from the test preload (one throwaway dir). Only the
  // file-specific config is set here; all of it is read lazily by the guardian.
  Bun.env.OP_ASSISTANT_URL = `http://127.0.0.1:${assistantPort}`;
  Bun.env.PORTAL_TEST_SECRET_FILE = secretPath;

  mockAssistantServer = startMockAssistant();

  initializePrincipalStore();
  seedPortalPrincipalsFromEnv(); // idempotent upsert of the `test` principal
  _setProxyEnabledForTest(true); // skip the async drift handshake — deterministic
});

afterAll(() => {
  mockAssistantServer?.stop(true);
  delete Bun.env.PORTAL_TEST_SECRET_FILE;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('Guardian server integration', () => {
  it('GET /health returns service metadata', async () => {
    const resp = await internal('/health');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.service).toBe('guardian');
  });

  it('GET /health/ready returns 200 when the proxy is enabled', async () => {
    const resp = await internal('/health/ready');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ready).toBe(true);
  });

  it('GET /stats reports current proxy and listener state', async () => {
    const resp = await internal('/stats');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.principals)).toBe(true);
    expect(data.principals.some((principal: { id?: string }) => principal.id === TEST_PRINCIPAL)).toBe(true);
    expect(data.direct_ingress_enabled).toBe(false);
    expect(data.oc_proxy.enabled).toBe(true);
    expect(typeof data.requests.total).toBe('number');
  });

  it('POST /oc/session authenticates with Basic auth and rewrites the session title', async () => {
    const resp = await ocCall('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'client title ignored' }),
    }, {
      userId: 'user-1',
      sessionKey: 'thread-1',
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()).id).toBe('mock-session-1');
    expect((lastCreateBody as { title?: string } | null)?.title).toBe('test/thread-1');
  });

  it('reuses the same upstream session for the same session key', async () => {
    const before = sessionCreateCount;
    const first = await ocCall('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, { userId: 'reuse-u', sessionKey: 'reuse-key' });
    const second = await ocCall('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, { userId: 'reuse-u', sessionKey: 'reuse-key' });
    expect((await first.json()).id).toBe((await second.json()).id);
    expect(sessionCreateCount - before).toBe(1);
  });

  it('missing Basic auth returns 401 unauthorized', async () => {
    const resp = await internal('/oc/session', { method: 'GET' });
    expect(resp.status).toBe(401);
    expect((await resp.json()).error).toBe('unauthorized');
  });

  it('invalid Basic auth returns 401 unauthorized', async () => {
    const resp = await ocCall('/session', { method: 'GET' }, { principalId: TEST_PRINCIPAL, secret: 'wrong-secret' });
    expect(resp.status).toBe(401);
    expect((await resp.json()).error).toBe('unauthorized');
  });

  it('unknown principal returns 401 unauthorized', async () => {
    const resp = await ocCall('/session', { method: 'GET' }, { principalId: 'missing-principal' });
    expect(resp.status).toBe(401);
    expect((await resp.json()).error).toBe('unauthorized');
  });

  it('assistant outage on session creation returns 502 oc_session_create_failed', async () => {
    await mockAssistantServer.stop(true); // await the close → next fetch is refused deterministically
    try {
      const resp = await ocCall('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, { userId: 'down-u', sessionKey: 'down-thread' });
      expect(resp.status).toBe(502);
      expect((await resp.json()).error).toBe('oc_session_create_failed');
    } finally {
      mockAssistantServer = startMockAssistant();
    }
  });

  it('unknown route returns 404', async () => {
    const resp = await internal('/unknown');
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe('not_found');
  });
});

describe('Guardian portal secret startup contract', () => {
  // The contract is entirely in what seedPortalPrincipalsFromEnv() returns for a
  // given env — assert that directly (idempotent upsert; no DB reset needed).
  it('ignores the legacy GUARDIAN_REQUIRE_PORTAL_SECRETS flag under principal seeding', () => {
    const prev = Bun.env.GUARDIAN_REQUIRE_PORTAL_SECRETS;
    Bun.env.GUARDIAN_REQUIRE_PORTAL_SECRETS = 'true';
    try {
      // PORTAL_TEST_SECRET_FILE is set in beforeAll; the legacy flag must not block it.
      expect(seedPortalPrincipalsFromEnv().some((p) => p.id === TEST_PRINCIPAL)).toBe(true);
    } finally {
      if (prev === undefined) delete Bun.env.GUARDIAN_REQUIRE_PORTAL_SECRETS;
      else Bun.env.GUARDIAN_REQUIRE_PORTAL_SECRETS = prev;
    }
  });

  it('allows zero portal grants for a core-only no-portal stack', () => {
    const prev = Bun.env.PORTAL_TEST_SECRET_FILE;
    delete Bun.env.PORTAL_TEST_SECRET_FILE;
    try {
      // No PORTAL_*_SECRET_FILE present → zero grants, and that's allowed (no throw).
      expect(seedPortalPrincipalsFromEnv()).toEqual([]);
    } finally {
      Bun.env.PORTAL_TEST_SECRET_FILE = prev as string;
    }
  });
});
