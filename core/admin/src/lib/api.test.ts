import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConnections,
  fetchConnectionsDto,
  saveSystemConnection,
} from './api.js';

const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');

describe('api canonical connections DTO adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomUuidSpy.mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
  });

  it('reads canonical connections DTO response shape', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profiles: [
              {
                id: 'primary',
                name: 'Primary connection',
                kind: 'openai_compatible_remote',
                provider: 'openai',
                baseUrl: 'https://api.openai.com',
                auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
              },
            ],
            assignments: {
              llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
              embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
            },
            connections: { SYSTEM_LLM_PROVIDER: 'openai' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const data = await fetchConnectionsDto('admin-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data.profiles[0].provider).toBe('openai');
    expect(data.assignments.llm.model).toBe('gpt-4.1-mini');
    expect(data.connections.SYSTEM_LLM_PROVIDER).toBe('openai');
  });

  it('keeps fetchConnections compatibility by returning connections map', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          profiles: [],
          assignments: {
            llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
            embeddings: { connectionId: 'primary', model: 'text-embedding-3-small' },
          },
          connections: {
            SYSTEM_LLM_PROVIDER: 'openai',
            SYSTEM_LLM_MODEL: 'gpt-4.1-mini',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const connections = await fetchConnections('admin-token');

    expect(connections.SYSTEM_LLM_PROVIDER).toBe('openai');
    expect(connections.SYSTEM_LLM_MODEL).toBe('gpt-4.1-mini');
  });

  it('posts canonical DTO payload for saveSystemConnection', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, pushed: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await saveSystemConnection('admin-token', {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com',
      systemModel: 'gpt-4.1-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      memoryUserId: 'default_user',
      customInstructions: '',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      profiles: Array<{ kind: string; provider: string }>;
      assignments: { llm: { model: string }; embeddings: { model: string; embeddingDims: number } };
      capabilities: string[];
    };

    expect(body.profiles[0].kind).toBe('openai_compatible_remote');
    expect(body.profiles[0].provider).toBe('openai');
    expect(body.assignments.llm.model).toBe('gpt-4.1-mini');
    expect(body.assignments.embeddings.embeddingDims).toBe(1536);
    expect(body.capabilities).toEqual(['llm', 'embeddings']);
  });
});
