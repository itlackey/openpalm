/**
 * Guardian boot-path integration — state DB WAL mode + user_version stamping
 * on a REAL spawned guardian process (#433).
 *
 * `state-db.test.ts` drives `configureStateDatabase` directly against raw
 * `bun:sqlite` connections; this file instead proves the same behavior holds
 * for the actual singleton `openDatabase()` seam exercised through a booted
 * guardian subprocess, matching the fixture pattern in `proxy-direct.test.ts`
 * (`getAvailablePort` + spawn + health poll) and `auth.test.ts` (env set
 * before the module that reads it is loaded — here, before the guardian
 * subprocess is spawned).
 *
 * `OP_ASSISTANT_URL` points at a dead port (no mock assistant needed) — the
 * admin listener (port GUARDIAN_ADMIN_PORT, `handleAdminListenerRequest`) works
 * regardless of whether the assistant is reachable.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Subprocess } from 'bun';
import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_TOKEN = 'admin-token-test-state-db-boot';

let guardianProc: Subprocess;
let adminUrl: string;
let tmpDir: string;
let dbPath: string;

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        s.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

beforeAll(async () => {
  const internalPort = await getAvailablePort();
  const directPort = await getAvailablePort();
  const adminPort = await getAvailablePort();
  const deadAssistantPort = await getAvailablePort(); // nothing listens here

  tmpDir = mkdtempSync(join(tmpdir(), 'guardian-state-db-boot-test-'));
  const adminTokenPath = join(tmpDir, 'admin-token');
  writeFileSync(adminTokenPath, `${ADMIN_TOKEN}\n`);
  dbPath = join(tmpDir, 'state.db');

  guardianProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(internalPort),
      GUARDIAN_DIRECT_PORT: String(directPort),
      GUARDIAN_ADMIN_PORT: String(adminPort),
      GUARDIAN_STATE_DB_PATH: dbPath,
      GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
      OP_ASSISTANT_URL: `http://127.0.0.1:${deadAssistantPort}`,
      GUARDIAN_AUDIT_PATH: join(tmpDir, 'audit.log'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  adminUrl = `http://127.0.0.1:${adminPort}`;

  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (guardianProc.exitCode !== null) throw new Error(`guardian exited: ${guardianProc.exitCode}`);
    try {
      const r = await fetch(`${adminUrl}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not ready */
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error('guardian admin listener not ready');
});

afterAll(() => {
  guardianProc?.kill();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('booted guardian — state DB WAL mode + user_version', () => {
  test('booted guardian state DB runs in WAL mode with user_version stamped', async () => {
    // Force a write through the admin API so the state DB (and its WAL
    // sidecar) is definitely materialized before we inspect it out-of-process.
    const resp = await fetch(`${adminUrl}/admin/principals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'boot-probe', kind: 'direct', token: 'boot-probe-secret' }),
    });
    expect(resp.status).toBe(200);

    const readonlyDb = new Database(dbPath, { readonly: true });
    const journalMode = (readonlyDb.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    const userVersion = (readonlyDb.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    readonlyDb.close();

    // Today (pre-#433) journal_mode is 'delete' and user_version is 0.
    expect(journalMode).toBe('wal');
    expect(userVersion).toBe(1);
  });

  test('state DB and WAL sidecars are guardian-private (0600)', async () => {
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    const walPath = `${dbPath}-wal`;
    // No -wal file exists today (journal_mode is not WAL yet), so this
    // existence assertion is the first thing to fail pre-implementation.
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).mode & 0o777).toBe(0o600);

    const shmPath = `${dbPath}-shm`;
    if (existsSync(shmPath)) {
      expect(statSync(shmPath).mode & 0o777).toBe(0o600);
    }
  });
});
