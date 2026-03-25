import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCapabilities,
  fetchCapabilitiesDto,
  saveCapabilities,
  testCapability,
} from './api.js';

const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');

describe('api capabilities DTO adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomUuidSpy.mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
  });

  it('reads capabilities + secrets response shape', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            capabilities: {
              llm: 'openai/gpt-4o-mini',
              embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
              memory: { userId: 'default_user', customInstructions: '' },
            },
            secrets: {
              OPENAI_API_KEY: 'sk-****1234',
              OWNER_NAME: '',
              OWNER_EMAIL: '',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const data = await fetchCapabilitiesDto('admin-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data.capabilities?.llm).toBe('openai/gpt-4o-mini');
    expect(data.capabilities?.embeddings.model).toBe('text-embedding-3-small');
    expect(data.secrets.OPENAI_API_KEY).toBe('sk-****1234');
  });

  it('keeps fetchCapabilities compatibility by returning secrets map', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          capabilities: {
            llm: 'openai/gpt-4o-mini',
            embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
            memory: { userId: 'default_user' },
          },
          secrets: {
            OPENAI_API_KEY: 'sk-****1234',
            OWNER_NAME: '',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const capabilities = await fetchCapabilities('admin-token');

    expect(capabilities.OPENAI_API_KEY).toBe('sk-****1234');
  });

  it('posts flat payload for saveCapabilities (legacy save)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await saveCapabilities('admin-token', {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com',
      systemModel: 'gpt-4o-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      memoryUserId: 'default_user',
      customInstructions: '',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      provider: string;
      apiKey: string;
      systemModel: string;
      embeddingModel: string;
      embeddingDims: number;
    };

    expect(body.provider).toBe('openai');
    expect(body.systemModel).toBe('gpt-4o-mini');
    expect(body.embeddingModel).toBe('text-embedding-3-small');
    expect(body.embeddingDims).toBe(1536);
  });

  it('posts flat payload for saveCapabilities', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await saveCapabilities('admin-token', {
      provider: 'openai',
      apiKey: 'sk-test',
      systemModel: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      memoryUserId: 'test_user',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      provider: string;
      systemModel: string;
      memoryUserId: string;
    };

    expect(body.provider).toBe('openai');
    expect(body.systemModel).toBe('gpt-4o');
    expect(body.memoryUserId).toBe('test_user');
  });

  it('uses the structured capability test endpoint', async () => {
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

    const result = await testCapability('admin-token', {
      baseUrl: 'http://localhost:11434',
      apiKey: '',
      kind: 'openai_compatible_local',
    });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gpt-4.1-mini']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/capabilities/test',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('returns empty capabilities on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 500 }),
    );

    const dto = await fetchCapabilitiesDto('admin-token');
    expect(dto.capabilities).toBeNull();
    expect(dto.secrets).toEqual({});
  });

  it('surfaces JSON error messages from saveCapabilities failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_request',
          message: 'provider is required',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      saveCapabilities('admin-token', { provider: '' }),
    ).rejects.toThrow('provider is required');
  });
});
