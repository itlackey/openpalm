import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('GET returns empty profiles list when profiles.json does not exist', async () => {
    const state = getState();
    const profilesPath = join(state.configDir, 'connections', 'profiles.json');
    rmSync(profilesPath, { force: true });

    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(200);

    const body = await res.json() as { profiles: unknown[] };
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.profiles).toHaveLength(0);
  });

  test('POST returns 400 when profile body is missing required fields', async () => {
    const res = await POST(makeEvent('POST', {
      profile: {
        // missing id, name, provider, auth
      },
    }));
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
  });

  test('POST returns 400 when profile auth.mode is api_key but apiKeySecretRef is missing', async () => {
    const res = await POST(makeEvent('POST', {
      profile: {
        id: 'bad-auth',
        name: 'Bad Auth',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: '',
        auth: { mode: 'api_key' }, // missing apiKeySecretRef
      },
    }));
    expect(res.status).toBe(400);
  });

  test('POST accepts a raw apiKey and stores a derived secret ref', async () => {
    const res = await POST(makeEvent('POST', {
      profile: {
        id: 'new-openai',
        name: 'New OpenAI',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        auth: { mode: 'api_key' },
        apiKey: 'sk-new-openai',
      },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      profile: {
        auth: {
          apiKeySecretRef: string;
        };
      };
    };
    expect(body.profile.auth.apiKeySecretRef).toBe('env:OPENAI_API_KEY');
    expect(readFileSync(join(getState().configDir, 'secrets.env'), 'utf-8')).toContain('OPENAI_API_KEY=sk-new-openai');
  });

  test('PUT returns 404 when updating a non-existent profile', async () => {
    const res = await PUT(makeEvent('PUT', {
      profile: {
        id: 'does-not-exist',
        name: 'Ghost',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: '',
        auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
      },
    }));
    expect(res.status).toBe(404);
  });

  test('DELETE returns 409 when profile is referenced by an assignment', async () => {
    const res = await DELETE(makeEvent('DELETE', { id: 'primary' }));
    expect(res.status).toBe(409);

    const body = await res.json() as { error: string; message: string };
    expect(body.message).toMatch(/in use/i);
  });

  test('DELETE returns 404 for an id that was never created', async () => {
    const res = await DELETE(makeEvent('DELETE', { id: 'never-existed' }));
    expect(res.status).toBe(404);
  });

  test('DELETE returns 400 when body has no id field', async () => {
    const res = await DELETE(makeEvent('DELETE', {}));
    expect(res.status).toBe(400);
  });

  test('full create → GET → update → delete lifecycle', async () => {
    const profile = {
      id: 'groq-cloud',
      name: 'Groq',
      kind: 'openai_compatible_remote',
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai',
      auth: { mode: 'api_key', apiKeySecretRef: 'env:GROQ_API_KEY' },
    };

    // Create
    const created = await POST(makeEvent('POST', { profile }));
    expect(created.status).toBe(200);

    // GET lists both seeded + new profile
    const listed = await GET(makeEvent('GET'));
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { profiles: Array<{ id: string }> };
    expect(listedBody.profiles.map((p) => p.id)).toContain('groq-cloud');

    // Duplicate POST returns 409
    const dup = await POST(makeEvent('POST', { profile }));
    expect(dup.status).toBe(409);

    // Update name
    const updated = await PUT(makeEvent('PUT', { profile: { ...profile, name: 'Groq (updated)' } }));
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { profile: { name: string } };
    expect(updatedBody.profile.name).toBe('Groq (updated)');

    // Delete
    const deleted = await DELETE(makeEvent('DELETE', { id: 'groq-cloud' }));
    expect(deleted.status).toBe(200);

    // Confirm gone
    const gone = await DELETE(makeEvent('DELETE', { id: 'groq-cloud' }));
    expect(gone.status).toBe(404);
  });

  test('PUT accepts a raw apiKey and refreshes the stored secret', async () => {
    const res = await PUT(makeEvent('PUT', {
      profile: {
        id: 'primary',
        name: 'OpenAI',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: '',
        auth: { mode: 'api_key' },
        apiKey: 'sk-updated-openai',
      },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      profile: {
        auth: {
          apiKeySecretRef: string;
        };
      };
    };
    expect(body.profile.auth.apiKeySecretRef).toBe('env:OPENAI_API_KEY');
    expect(readFileSync(join(getState().configDir, 'secrets.env'), 'utf-8')).toContain('OPENAI_API_KEY=sk-updated-openai');
  });
});
