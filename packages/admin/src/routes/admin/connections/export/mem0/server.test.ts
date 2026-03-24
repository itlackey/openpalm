import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';
import { writeStackSpec, type StackSpec } from '@openpalm/lib';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-mem0-export-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedStackYaml(): void {
  const state = getState();
  const spec: StackSpec = {
    version: 2,
    capabilities: {
      llm: 'openai/gpt-4o',
      embeddings: { provider: 'google', model: 'text-embedding-004', dims: 768 },
      memory: { userId: 'default_user' },
    },
    addons: {},
  };
  writeStackSpec(state.configDir, spec);
}

function makeEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/connections/export/mem0', {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-mem0-export',
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
  seedStackYaml();
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('/admin/connections/export/mem0 route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('uses the embedding provider key mapping for embedder api keys', async () => {
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text()) as {
      mem0: {
        llm: { config: { api_key: string } };
        embedder: { config: { api_key: string } };
      };
    };

    expect(body.mem0.llm.config.api_key).toBe('env:OPENAI_API_KEY');
    expect(body.mem0.embedder.config.api_key).toBe('env:GOOGLE_API_KEY');
  });
});
