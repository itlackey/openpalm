/**
 * handleProxy end-to-end harness (#586, AC1 / decision 586-4) — pins that a
 * session-scoped /oc request TOUCHES (refreshes) session_owners.last_used_at
 * through the REAL request path. The eviction-avoidance consequence of that
 * touch (a recently-used session surviving repeated cap-crossings) is already
 * covered at the unit level in state-db.test.ts; this harness is the missing
 * piece decision 586-4 calls for — no handleProxy-level test existed anywhere
 * in this package before it.
 *
 * Why a subprocess: many OTHER test files in this package statically import
 * proxy.ts / state-db.ts, and bun:test shares its module cache across files
 * (see auth.test.ts's docstring on the same constraint against the singleton
 * `openDatabase()`). An in-process dynamic import here could silently reuse
 * an ALREADY env-bound singleton some other file claimed first. Spawning the
 * real guardian (`src/server.ts`) as its own child process sidesteps that
 * entirely — its own module graph, driven purely over real HTTP against a
 * `Bun.serve` stub standing in for the assistant, same as a running stack.
 *
 * Manual validation checklist (decision 586-4, corrected — the internal /oc
 * listener (8080) is not host-published in the shipped stack, so this cannot
 * be observed directly from the host):
 *   1. Plumb GUARDIAN_SESSION_ACTIVE_GRACE_MS / GUARDIAN_RECONCILE_INTERVAL_MS
 *      via a compose override (portals.compose.yml already has the
 *      `${VAR:-default}` knobs).
 *   2. Drive a session through the OpenAI-compatible edge on
 *      127.0.0.1:3821 (authenticates upstream as the seeded `api` portal
 *      principal) — send an initial message, then a follow-up a few minutes
 *      later on the SAME session.
 *   3. Meanwhile generate enough other traffic/sessions to cross
 *      GUARDIAN_OWNERSHIP_MAX_ROWS.
 *   4. Read GET /stats with the admin bearer token: the followed-up session
 *      must never show up in a growing `oc_proxy.pending_evicted_sessions`
 *      count, even as the cap is repeatedly crossed by other sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'server.ts');

/** Grab a free TCP port by briefly binding to port 0 and releasing it. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // guardian not listening yet
    }
    if (Date.now() > deadline) throw new Error('guardian subprocess did not become healthy in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('handleProxy session-scoped requests touch session_owners.last_used_at (#586 AC1)', () => {
  let tmpDir: string;
  let dbPath: string;
  let stub: ReturnType<typeof Bun.serve>;
  let guardian: ReturnType<typeof Bun.spawn>;
  let guardianBaseUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-handleproxy-'));
    dbPath = join(tmpDir, 'state.db');
    const secretFile = join(tmpDir, 'api-secret');
    writeFileSync(secretFile, 'topsecret');
    const opencodePasswordFile = join(tmpDir, 'opencode-password');
    writeFileSync(opencodePasswordFile, 'upstream-key\n');
    // A second, distinct portal principal — used to pin that the ownsSession
    // gate (proxy.ts) runs BEFORE touchSessionOwner, so a non-owning
    // authenticated principal is denied AND never refreshes last_used_at
    // (would otherwise let one principal keep another's session alive, and
    // confirm the session id exists by side effect).
    const otherSecretFile = join(tmpDir, 'other-secret');
    writeFileSync(otherSecretFile, 'othersecret');

    // Stub assistant: only the two endpoints this harness exercises.
    stub = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/session' && req.method === 'POST') {
          return Response.json({ id: 'ses_abc' });
        }
        if (url.pathname === '/session/ses_abc' && req.method === 'GET') {
          return Response.json({ id: 'ses_abc', time: { created: Date.now(), updated: Date.now() } });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const internalPort = freePort();
    const directPort = freePort();
    const adminPort = freePort();

    guardian = Bun.spawn({
      cmd: ['bun', 'run', serverEntry],
      env: {
        ...process.env,
        PORT: String(internalPort),
        GUARDIAN_DIRECT_PORT: String(directPort),
        GUARDIAN_ADMIN_PORT: String(adminPort),
        GUARDIAN_STATE_DB_PATH: dbPath,
        GUARDIAN_AUDIT_PATH: join(tmpDir, 'audit.log'),
        OP_ASSISTANT_URL: `http://127.0.0.1:${stub.port}`,
        // OpenCode auth is always on: startGuardian asserts the upstream
        // credential at boot, so the harness must grant the secret file.
        OPENCODE_SERVER_PASSWORD_FILE: opencodePasswordFile,
        PORTAL_API_SECRET_FILE: secretFile,
        PORTAL_OTHER_SECRET_FILE: otherSecretFile,
        // Disable the periodic sweep — irrelevant to this harness and would
        // otherwise fire against the stub on an unrelated timer.
        GUARDIAN_RECONCILE_INTERVAL_MS: '0',
        GUARDIAN_MCP: 'false',
        GUARDIAN_DIRECT_INGRESS: 'false',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    guardianBaseUrl = `http://127.0.0.1:${internalPort}`;
    await waitForHealth(guardianBaseUrl, 10_000);
  }, 20_000);

  afterAll(() => {
    guardian?.kill();
    stub?.stop(true);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function authHeader(id: string, secret: string): string {
    return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  }

  function lastUsedAt(sessionId: string): number {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.query('SELECT last_used_at FROM session_owners WHERE session_id = ?').get(sessionId) as
        | { last_used_at: number }
        | null;
      if (!row) throw new Error(`no session_owners row for ${sessionId}`);
      return row.last_used_at;
    } finally {
      raw.close();
    }
  }

  it('a session-scoped GET refreshes last_used_at past its creation-time value', async () => {
    const createResp = await fetch(`${guardianBaseUrl}/oc/session`, {
      method: 'POST',
      headers: { authorization: authHeader('api', 'topsecret'), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(createResp.status).toBe(200);

    const createdLastUsedAt = lastUsedAt('ses_abc');
    // A real (small) sleep so a subsequent touch is measurably later — the
    // column stores millisecond epoch ints, so a same-millisecond touch would
    // be indistinguishable from a no-op.
    await new Promise((r) => setTimeout(r, 20));

    const scopedResp = await fetch(`${guardianBaseUrl}/oc/session/ses_abc`, {
      method: 'GET',
      headers: { authorization: authHeader('api', 'topsecret') },
    });
    expect(scopedResp.status).toBe(200);

    expect(lastUsedAt('ses_abc')).toBeGreaterThan(createdLastUsedAt);
  }, 15_000);

  it('a request from an unknown principal is denied (401) and does NOT touch the session', async () => {
    const before = lastUsedAt('ses_abc');
    await new Promise((r) => setTimeout(r, 20));

    const resp = await fetch(`${guardianBaseUrl}/oc/session/ses_abc`, {
      method: 'GET',
      headers: { authorization: authHeader('nobody', 'wrong') },
    });
    expect(resp.status).toBe(401);

    expect(lastUsedAt('ses_abc')).toBe(before);
  }, 15_000);

  it('a request from an authenticated but non-owning principal is denied (403) and does NOT touch the session', async () => {
    const before = lastUsedAt('ses_abc');
    await new Promise((r) => setTimeout(r, 20));

    // 'other' is a real, seeded principal (unlike the unknown-principal 401
    // case above) — it authenticates fine but never created/owns ses_abc.
    const resp = await fetch(`${guardianBaseUrl}/oc/session/ses_abc`, {
      method: 'GET',
      headers: { authorization: authHeader('other', 'othersecret') },
    });
    expect(resp.status).toBe(403);

    expect(lastUsedAt('ses_abc')).toBe(before);
  }, 15_000);
});
