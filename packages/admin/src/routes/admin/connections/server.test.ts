import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import {
  readConnectionProfilesDocument,
  readMemoryConfig,
} from '$lib/server/control-plane.js';
import { POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OPENPALM_HOME;
  process.env.OPENPALM_HOME = rootDir;
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  writeFileSync(join(state.configDir, 'secrets.env'), 'OPENAI_API_KEY=sk-test\n');

  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.OPENPALM_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

function makeEvent(body: unknown, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/connections', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        'x-request-id': 'req-1',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

describe('/admin/connections route', () => {
  test('saves canonical DTO settings using setup-style assignments', async () => {
    const res = await POST(makeEvent({
      profiles: [
        {
          id: 'primary',
          name: 'OpenAI',
          kind: 'openai_compatible_remote',
          provider: 'openai',
          baseUrl: 'https://api.openai.com',
          auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
        },
        {
          id: 'embed',
          name: 'Embeddings',
          kind: 'openai_compatible_remote',
          provider: 'openai',
          baseUrl: 'https://api.openai.com',
          auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
        },
      ],
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4o', smallModel: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'embed', model: 'text-embedding-3-small', embeddingDims: 1536 },
        reranking: { enabled: true, connectionId: 'primary', mode: 'dedicated', model: 'rerank-2', topN: 8 },
        tts: { enabled: true, connectionId: 'primary', model: 'tts-1', voice: 'alloy', format: 'mp3' },
        stt: { enabled: true, connectionId: 'primary', model: 'whisper-1', language: 'en' },
      },
      memoryModel: 'gpt-4.1-mini',
      memoryUserId: 'memory-user',
      customInstructions: 'Be concise.',
    }));

    expect(res.status).toBe(200);

    const state = getState();
    const connections = readConnectionProfilesDocument(state.configDir);
    expect(connections.assignments.llm.smallModel).toBe('gpt-4.1-mini');
    expect(connections.assignments.reranking?.model).toBe('rerank-2');
    expect(connections.assignments.tts?.voice).toBe('alloy');
    expect(connections.assignments.stt?.language).toBe('en');

    const memoryConfig = readMemoryConfig(state.dataDir);
    expect(memoryConfig.mem0.llm.config.model).toBe('gpt-4.1-mini');
    expect(memoryConfig.mem0.embedder.config.model).toBe('text-embedding-3-small');
    expect(memoryConfig.memory.custom_instructions).toBe('Be concise.');

    const opencodeConfig = JSON.parse(
      readFileSync(join(state.configDir, 'assistant', 'opencode.json'), 'utf8'),
    ) as { model: string; smallModel: string };
    expect(opencodeConfig.model).toBe('gpt-4o');
    expect(opencodeConfig.smallModel).toBe('gpt-4.1-mini');
  });
});
