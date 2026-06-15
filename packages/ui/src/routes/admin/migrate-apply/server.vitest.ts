/**
 * Tests for POST /admin/migrate-apply.
 *
 * Asserts:
 *  - 401 without auth
 *  - 200 + a real layout migration is applied (1 -> 2 removes the inert
 *    channels.compose.yml), report shape, and a backup is taken
 *  - idempotent: a second apply on the now-current home is a no-op
 */
import { beforeEach, afterEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

let home = '';
let originalHome: string | undefined;

function seed(rel: string, content: string) {
  const full = join(home, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function makeEvent(token = 'admin-token', body: unknown = {}) {
  return {
    request: new Request('http://localhost/admin/migrate-apply', {
      method: 'POST',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'content-type': 'application/json',
        'x-request-id': 'req-migrate-apply-1',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  home = join(tmpdir(), `op-migrate-apply-${randomBytes(4).toString('hex')}`);
  mkdirSync(home, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = home;
  resetState('admin-token');
  // Seed a 0.11.x layout-v1 home with a pending 1 -> 2 migration: the inert
  // channels.compose.yml must be removed by the layout migration.
  seed('knowledge/env/stack.env', 'OP_LAYOUT_VERSION=1\nOP_SETUP_COMPLETE=true\n');
  seed('config/stack/core.compose.yml', 'services: {}\n');
  seed('config/stack/channels.compose.yml', 'services: {}\n');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('POST /admin/migrate-apply', () => {
  test('returns 401 without auth', async () => {
    const res = await POST(makeEvent(''));
    expect(res.status).toBe(401);
  });

  test('applies the pending layout migration and reports it', async () => {
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.migrated).toBe(true);
    expect(body.from).toBe(1);
    expect(body.to).toBe(2);
    expect(body.applied).toContain('1->2');
    expect(body.backupDir).toBeTruthy();
    // The inert system file is gone; user/managed files remain.
    expect(existsSync(join(home, 'config/stack/channels.compose.yml'))).toBe(false);
    expect(existsSync(join(home, 'config/stack/core.compose.yml'))).toBe(true);
  });

  test('is idempotent — a second apply is a no-op', async () => {
    await POST(makeEvent());
    const res = await POST(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.migrated).toBe(false);
  });
});
