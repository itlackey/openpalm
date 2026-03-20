import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { writeConnectionsDocument } from '$lib/server/connection-profiles.js';
import { DELETE, GET, PUT } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  writeFileSync(
    join(state.configDir, 'secrets.env'),
    'OPENAI_API_KEY=sk-test\nSYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_MODEL=gpt-4.1-mini\nEMBEDDING_MODEL=text-embedding-3-small\nEMBEDDING_DIMS=1536\n'
  );

  // Seed profiles.json with a known profile
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
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

function makeEvent(
  method: string,
  id: string,
  body?: unknown,
  token = 'admin-token'
): Parameters<typeof GET>[0] {
  return {
    request: new Request(`http://localhost/admin/connections/profiles/${id}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        'x-request-id': 'req-1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params: { id },
  } as Parameters<typeof GET>[0];
}

describe('/admin/connections/profiles/[id] route', () => {
  test('GET requires admin token', async () => {
    const res = await GET(makeEvent('GET', 'primary', undefined, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('GET returns existing profile by id', async () => {
    const res = await GET(makeEvent('GET', 'primary'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.id).toBe('primary');
    expect(body.profile.name).toBe('OpenAI');
  });

  test('GET returns 404 for unknown id', async () => {
    const res = await GET(makeEvent('GET', 'does-not-exist'));
    expect(res.status).toBe(404);
  });

  test('PUT updates an existing profile', async () => {
    const res = await PUT(makeEvent('PUT', 'primary', {
      profile: {
        id: 'primary',
        name: 'OpenAI Updated',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: '',
        auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
      },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.name).toBe('OpenAI Updated');
    expect(body.profile.id).toBe('primary');
  });

  test('PUT returns 404 for unknown id', async () => {
    const res = await PUT(makeEvent('PUT', 'ghost-profile', {
      profile: {
        id: 'ghost-profile',
        name: 'Ghost',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: '',
        auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
      },
    }));
    expect(res.status).toBe(404);
  });

  test('DELETE removes an existing profile', async () => {
    // First add a second profile so primary has no in-use constraint after deletion
    const { createConnectionProfile } = await import('$lib/server/control-plane.js');
    const state = getState();
    createConnectionProfile(state.configDir, {
      id: 'secondary',
      name: 'Ollama Local',
      kind: 'openai_compatible_local',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      auth: { mode: 'none' },
    });

    const res = await DELETE(makeEvent('DELETE', 'secondary'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('secondary');
  });

  test('DELETE returns 409 when profile is in use by assignments', async () => {
    // 'primary' is assigned as LLM — should be rejected
    const res = await DELETE(makeEvent('DELETE', 'primary'));
    expect(res.status).toBe(409);
  });

  test('DELETE returns 404 for unknown id', async () => {
    const res = await DELETE(makeEvent('DELETE', 'no-such-profile'));
    expect(res.status).toBe(404);
  });
});
