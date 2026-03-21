import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { writeConnectionsDocument } from '$lib/server/connection-profiles.js';
import { GET, POST } from './+server.js';

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

  // Seed stack.yaml with connection profiles
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

function makeEvent(method: string, body?: unknown, token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/connections/assignments', {
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

describe('/admin/connections/assignments route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('GET', undefined, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns assignments and enforces connection id conflict checks', async () => {
    const current = await GET(makeEvent('GET'));
    expect(current.status).toBe(200);

    const invalid = await POST(makeEvent('POST', {
      assignments: {
        llm: { connectionId: 'missing', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    }));
    expect(invalid.status).toBe(409);

    const valid = await POST(makeEvent('POST', {
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    }));
    expect(valid.status).toBe(200);
  });

  test('GET returns empty-default assignments when stack.yaml does not exist', async () => {
    const state = getState();
    const profilesPath = join(state.configDir, 'stack.yaml');
    rmSync(profilesPath, { force: true });

    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      assignments: {
        llm: { connectionId: string; model: string };
        embeddings: { connectionId: string; model: string };
      };
    };
    expect(body.assignments.llm.connectionId).toBe('');
    expect(body.assignments.embeddings.connectionId).toBe('');
  });

  test('POST returns 400 when assignments body is missing', async () => {
    const res = await POST(makeEvent('POST', {}));
    expect(res.status).toBe(400);
  });

  test('POST returns 409 when embeddings connectionId references unknown profile', async () => {
    const res = await POST(makeEvent('POST', {
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'does-not-exist', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    }));
    expect(res.status).toBe(409);
  });

  test('POST saves valid assignments and responds 200 with persisted data', async () => {
    const res = await POST(makeEvent('POST', {
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      ok: boolean;
      assignments: {
        llm: { connectionId: string; model: string };
        embeddings: { connectionId: string; model: string; embeddingDims: number };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.assignments.llm.connectionId).toBe('primary');
    expect(body.assignments.llm.model).toBe('gpt-4.1-mini');
    expect(body.assignments.embeddings.embeddingDims).toBe(1536);
  });

  test('POST persists to disk — subsequent GET reflects saved model', async () => {
    await POST(makeEvent('POST', {
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4-turbo' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-ada-002', embeddingDims: 1536 },
      },
    }));

    const getRes = await GET(makeEvent('GET'));
    expect(getRes.status).toBe(200);

    const body = await getRes.json() as {
      assignments: { llm: { model: string }; embeddings: { model: string } };
    };
    expect(body.assignments.llm.model).toBe('gpt-4-turbo');
    expect(body.assignments.embeddings.model).toBe('text-embedding-ada-002');
  });
});
