import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConnections,
  fetchConnectionsDto,
  createConnectionProfile,
  deleteConnectionProfile,
  saveSystemConnection,
  saveConnectionsDto,
  testConnectionProfile,
  updateConnectionProfile,
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

  it('posts full DTO payload for saveConnectionsDto including optional capability fields', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, pushed: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await saveConnectionsDto('admin-token', {
      profiles: [
        {
          id: 'p1',
          name: 'Remote',
          kind: 'openai_compatible_remote',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
        },
      ],
      assignments: {
        llm: { connectionId: 'p1', model: 'gpt-4o' },
        embeddings: { connectionId: 'p1', model: 'text-embedding-3-small', embeddingDims: 1536 },
        tts: { enabled: true, connectionId: 'p1', model: 'tts-1', voice: 'nova' },
        stt: { enabled: false },
      },
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      profiles: Array<{ kind: string }>;
      assignments: {
        llm: { model: string };
        embeddings: { embeddingDims: number };
        tts: { enabled: boolean; voice: string };
        stt: { enabled: boolean };
      };
    };

    expect(body.profiles[0].kind).toBe('openai_compatible_remote');
    expect(body.assignments.llm.model).toBe('gpt-4o');
    expect(body.assignments.embeddings.embeddingDims).toBe(1536);
    expect(body.assignments.tts.enabled).toBe(true);
    expect(body.assignments.tts.voice).toBe('nova');
    expect(body.assignments.stt.enabled).toBe(false);
  });

  it('surfaces JSON error messages from profile create failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_request',
          message: 'Profile name is required.',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      createConnectionProfile('admin-token', {
        id: 'p1',
        name: '',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        auth: { mode: 'none' },
      }),
    ).rejects.toThrow('Profile name is required.');
  });

  it('surfaces JSON error messages from profile update failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_request',
          message: 'Profile provider is invalid.',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      updateConnectionProfile('admin-token', {
        id: 'p1',
        name: 'Example',
        kind: 'openai_compatible_remote',
        provider: 'bad-provider',
        baseUrl: 'https://api.openai.com/v1',
        auth: { mode: 'none' },
      }),
    ).rejects.toThrow('Profile provider is invalid.');
  });

  it('surfaces JSON error messages from profile delete failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_request',
          message: 'Profile could not be deleted.',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(deleteConnectionProfile('admin-token', 'p1')).rejects.toThrow(
      'Profile could not be deleted.',
    );
  });

  it('uses the structured connection test endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          models: ['gpt-4.1-mini'],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await testConnectionProfile('admin-token', {
      baseUrl: 'http://localhost:11434',
      apiKey: '',
      kind: 'openai_compatible_local',
    });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gpt-4.1-mini']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/connections/test',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('falls back to plain text error bodies for profile create failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Plain text failure', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    await expect(
      createConnectionProfile('admin-token', {
        id: 'p1',
        name: 'Example',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        auth: { mode: 'none' },
      }),
    ).rejects.toThrow('Plain text failure');
  });

  it('falls back to the default error copy when the response body is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', {
        status: 500,
      }),
    );

    await expect(
      createConnectionProfile('admin-token', {
        id: 'p1',
        name: 'Example',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        auth: { mode: 'none' },
      }),
    ).rejects.toThrow('Request failed (HTTP 500)');
  });
});
