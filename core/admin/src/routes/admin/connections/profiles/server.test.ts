import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { writeConnectionsDocument } from '$lib/server/connection-profiles.js';
import { DELETE, GET, POST, PUT } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalConfigHome: string | undefined;
let originalStateHome: string | undefined;
let originalDataHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalConfigHome = process.env.OPENPALM_CONFIG_HOME;
  originalStateHome = process.env.OPENPALM_STATE_HOME;
  originalDataHome = process.env.OPENPALM_DATA_HOME;
  process.env.OPENPALM_CONFIG_HOME = join(rootDir, 'config');
  process.env.OPENPALM_STATE_HOME = join(rootDir, 'state');
  process.env.OPENPALM_DATA_HOME = join(rootDir, 'data');
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  writeFileSync(
    join(state.configDir, 'secrets.env'),
    'OPENAI_API_KEY=sk-test\nSYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_MODEL=gpt-4.1-mini\nEMBEDDING_MODEL=text-embedding-3-small\nEMBEDDING_DIMS=1536\n'
  );

  // Seed profiles.json so readConnectionProfilesDocument doesn't throw
  writeConnectionsDocument(state.configDir, {
    profiles: [{
      id: 'primary',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: '',
      hasApiKey: true,
      apiKeyEnvVar: 'OPENAI_API_KEY',
    }],
    assignments: {
      llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
      embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
    },
  });
});

afterEach(() => {
  process.env.OPENPALM_CONFIG_HOME = originalConfigHome;
  process.env.OPENPALM_STATE_HOME = originalStateHome;
  process.env.OPENPALM_DATA_HOME = originalDataHome;
  rmSync(rootDir, { recursive: true, force: true });
});

function makeEvent(method: string, body?: unknown, token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/connections/profiles', {
      method,
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        'x-request-id': 'req-1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof GET>[0];
}

describe('/admin/connections/profiles route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('GET', undefined, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('supports create, update, and delete with deterministic conflicts', async () => {
    const createBody = {
      profile: {
        id: 'local-lmstudio',
        name: 'LM Studio',
        kind: 'openai_compatible_local',
        provider: 'lmstudio',
        baseUrl: 'http://host.docker.internal:1234',
        auth: { mode: 'none' },
      },
    };

    const created = await POST(makeEvent('POST', createBody));
    expect(created.status).toBe(200);

    const duplicate = await POST(makeEvent('POST', createBody));
    expect(duplicate.status).toBe(409);

    const updated = await PUT(makeEvent('PUT', {
      profile: {
        ...createBody.profile,
        name: 'LM Studio Updated',
      },
    }));
    expect(updated.status).toBe(200);

    const deleted = await DELETE(makeEvent('DELETE', { id: 'local-lmstudio' }));
    expect(deleted.status).toBe(200);

    const missing = await DELETE(makeEvent('DELETE', { id: 'local-lmstudio' }));
    expect(missing.status).toBe(404);
  });
});
