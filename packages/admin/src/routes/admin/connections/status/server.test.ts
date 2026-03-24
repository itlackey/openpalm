import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { GET } from './+server.js';
import { writeStackSpec, type StackSpec } from '@openpalm/lib';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-status-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedStackYaml(capabilities: Record<string, unknown>): void {
  const state = getState();
  const spec: StackSpec = { version: 2, capabilities: capabilities as StackSpec['capabilities'], addons: {} };
  writeStackSpec(state.configDir, spec);
}

function makeEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/connections/status', {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-status',
      },
    }),
  } as Parameters<typeof GET>[0];
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('/admin/connections/status route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('treats whitespace-only capability values as missing', async () => {
    seedStackYaml({
      llm: '   ',
      embeddings: {
        provider: '   ',
        model: '   ',
        dims: 1536,
      },
      memory: {
        userId: 'default_user',
      },
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as { complete: boolean; missing: string[] };
    expect(body.complete).toBe(false);
    expect(body.missing).toContain('System LLM (capabilities.llm)');
    expect(body.missing).toContain('Embedding model (capabilities.embeddings)');
  });
});
