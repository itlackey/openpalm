import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Subprocess } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OC_DOC_FIXTURE } from './oc-doc-fixture.ts';

const TEST_SECRET = 'cors-secret-1234';
const TEST_PRINCIPAL = 'cors-direct';
const TEST_ADMIN_TOKEN = 'cors-admin-token-1234';
const ALLOWED_ORIGIN = 'https://app.openpalm.dev';
const DENIED_ORIGIN = 'https://evil.example';

let guardianProc: Subprocess;
let mockAssistantServer: ReturnType<typeof Bun.serve>;
let tmpDir: string;
let assistantPort = 0;
let internalPort = 0;
let directPort = 0;
let adminPort = 0;
let directUrl: string;
let adminUrl: string;

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

function directOcCall(
  path: string,
  init: RequestInit = {},
  opts: { origin?: string; userId?: string; withAuth?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (opts.withAuth !== false) headers.set('authorization', authorization());
  if (opts.userId) headers.set('x-openpalm-user', opts.userId);
  if (opts.origin) headers.set('origin', opts.origin);
  return fetch(`${directUrl}/oc${path}`, { ...init, headers });
}

function adminRequest(origin?: string): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${TEST_ADMIN_TOKEN}` });
  if (origin) headers.set('origin', origin);
  return fetch(`${adminUrl}/admin/principals`, { headers });
}

async function seedDirectPrincipal(): Promise<void> {
  const resp = await fetch(`${adminUrl}/admin/principals`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: TEST_PRINCIPAL,
      kind: 'direct',
      token: TEST_SECRET,
      label: 'CORS direct test client',
    }),
  });
  if (!resp.ok) throw new Error(`failed to seed direct principal: ${resp.status} ${await resp.text()}`);
}

async function waitForGuardianReady(): Promise<void> {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (guardianProc.exitCode !== null) {
      throw new Error(`guardian exited before ready with code ${guardianProc.exitCode}`);
    }
    try {
      const resp = await fetch(`${directUrl}/health`);
      if (resp.ok) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error('guardian did not become ready');

  for (let i = 0; i < 50; i++) {
    const resp = await fetch(`http://127.0.0.1:${internalPort}/stats`, {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    if (resp.ok && (await resp.json()).oc_proxy?.enabled === true) return;
    await Bun.sleep(100);
  }
  throw new Error('guardian /oc proxy did not enable');
}

function startMockAssistant(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: assistantPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/doc' && req.method === 'GET') return Response.json(OC_DOC_FIXTURE);
      if (url.pathname === '/session' && req.method === 'GET') return Response.json([]);
      if (url.pathname === '/session' && req.method === 'POST') return Response.json({ id: 'cors-session-1' });
      if (url.pathname.startsWith('/session/') && req.method === 'GET') return Response.json({ id: 'cors-session-1' });
      if (url.pathname.startsWith('/session/') && url.pathname.endsWith('/message') && req.method === 'POST') {
        return Response.json({ parts: [{ type: 'text', text: 'ok' }] });
      }
      return new Response('not found', { status: 404 });
    },
  });
}

beforeAll(async () => {
  assistantPort = await getAvailablePort();
  internalPort = await getAvailablePort();
  directPort = await getAvailablePort();
  adminPort = await getAvailablePort();

  tmpDir = mkdtempSync(join(tmpdir(), 'guardian-cors-test-'));
  const secretPath = join(tmpDir, 'test-secret');
  const adminTokenPath = join(tmpDir, 'admin-token');
  writeFileSync(secretPath, `${TEST_SECRET}\n`);
  writeFileSync(adminTokenPath, `${TEST_ADMIN_TOKEN}\n`);

  mockAssistantServer = startMockAssistant();
  guardianProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(internalPort),
      GUARDIAN_DIRECT_PORT: String(directPort),
      GUARDIAN_ADMIN_PORT: String(adminPort),
      GUARDIAN_DIRECT_INGRESS: 'true',
      GUARDIAN_CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      GUARDIAN_STATE_DB_PATH: join(tmpDir, 'state.db'),
      GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
      GUARDIAN_INTERNAL_HOST: '127.0.0.1',
      OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
      GUARDIAN_AUDIT_PATH: join(tmpDir, 'audit.log'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  directUrl = `http://127.0.0.1:${directPort}`;
  adminUrl = `http://127.0.0.1:${adminPort}`;
  await waitForGuardianReady();
  await seedDirectPrincipal();
});

afterAll(() => {
  guardianProc?.kill();
  mockAssistantServer?.stop(true);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('Guardian direct-ingress CORS', () => {
  it('answers allowed-origin preflight requests on /oc routes', async () => {
    const resp = await fetch(`${directUrl}/oc/session`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-openpalm-user',
      },
    });

    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(resp.headers.get('access-control-allow-credentials')).toBe('true');
    expect(resp.headers.get('access-control-allow-methods')).toContain('POST');
    expect(resp.headers.get('access-control-allow-headers')).toBe('authorization, content-type, x-openpalm-user');
    expect(resp.headers.get('vary')).toContain('Origin');
    expect(resp.headers.get('vary')).toContain('Access-Control-Request-Headers');
  });

  it('adds CORS headers to allowed-origin success responses', async () => {
    const resp = await directOcCall('/session', { method: 'GET' }, { origin: ALLOWED_ORIGIN, userId: 'allowed-user' });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(resp.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('adds CORS headers to allowed-origin error responses', async () => {
    const resp = await directOcCall('/session', { method: 'GET' }, { origin: ALLOWED_ORIGIN, withAuth: false });

    expect(resp.status).toBe(401);
    expect((await resp.json()).error).toBe('unauthorized');
    expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(resp.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('denies preflight for origins outside the allowlist', async () => {
    const resp = await fetch(`${directUrl}/oc/session`, {
      method: 'OPTIONS',
      headers: {
        origin: DENIED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-openpalm-user',
      },
    });

    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe('cors_origin_denied');
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
    expect(resp.headers.get('vary')).toContain('Origin');
    expect(resp.headers.get('vary')).toContain('Access-Control-Request-Headers');
  });

  it('does not add CORS headers to denied-origin actual responses', async () => {
    const resp = await directOcCall('/session', { method: 'GET' }, { origin: DENIED_ORIGIN, userId: 'denied-user' });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
    expect(resp.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('keeps allowed-origin /mcp disabled responses out of browser-side CORS failure', async () => {
    const preflight = await fetch(`${directUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const resp = await fetch(`${directUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: authorization(),
        origin: ALLOWED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ping' }),
    });

    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe('not_found');
    expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(resp.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('keeps the admin listener out of CORS', async () => {
    const resp = await adminRequest(ALLOWED_ORIGIN);

    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
    expect(resp.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('does not treat non-browser OPTIONS without an Origin as CORS preflight', async () => {
    const resp = await fetch(`${directUrl}/oc/session`, {
      method: 'OPTIONS',
      headers: {
        authorization: authorization(),
      },
    });

    expect(resp.status).not.toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
  });
});
