import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCapabilities } from './api.js';

const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');

describe('api capabilities adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomUuidSpy.mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
  });

  it('fetchCapabilities returns secrets map', async () => {
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

  it('returns empty on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 500 }),
    );

    const result = await fetchCapabilities('admin-token');
    expect(result).toEqual({});
  });

  it('throws on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 401 }),
    );

    await expect(fetchCapabilities('bad-token')).rejects.toThrow('Invalid admin token');
  });
});
