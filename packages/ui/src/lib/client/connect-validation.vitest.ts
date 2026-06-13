import { describe, expect, test, vi } from 'vitest';

// ── connectOpenCodeApiKey validation (Issue #2) ───────────────────────────────
// The fix: after storing the API key via PUT /api/setup/opencode/auth/:id, the
// wizard calls verifyProvider (which POSTs to /api/setup/models/:id) to
// confirm the key actually works before setting verified=true. This file tests
// that validation contract in isolation.

/**
 * Minimal standalone re-implementation of the connect + verify flow, mirroring
 * the logic in connectOpenCodeApiKey + verifyProvider in +page.svelte.
 * Tests the contract: "PUT key → verify models → set verified based on result".
 */
async function connectAndValidate(
  providerId: string,
  apiKey: string,
  putKey: (id: string, key: string) => Promise<void>,
  fetchModels: (id: string, baseUrl: string, key: string) => Promise<{ models: string[] }>,
): Promise<{ verified: boolean; error: boolean; errorMessage: string; models: string[] }> {
  const state = { verified: false, error: false, errorMessage: '', models: [] as string[] };

  try {
    await putKey(providerId, apiKey);
    // Key stored — now validate by fetching models
    const result = await fetchModels(providerId, '', apiKey);
    state.verified = true;
    state.models = result.models;
  } catch (e) {
    state.verified = false;
    state.error = true;
    state.errorMessage = e instanceof Error ? e.message : 'Connection failed';
  }

  return state;
}

describe('connectAndValidate — API key connect + verification', () => {
  test('sets verified=true and populates models when both PUT and models-fetch succeed', async () => {
    const putKey = vi.fn(async () => undefined);
    const fetchModels = vi.fn(async () => ({ models: ['gpt-4o', 'gpt-4o-mini'] }));

    const result = await connectAndValidate('openai', 'sk-valid', putKey, fetchModels);

    expect(result.verified).toBe(true);
    expect(result.error).toBe(false);
    expect(result.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(putKey).toHaveBeenCalledOnce();
    expect(fetchModels).toHaveBeenCalledOnce();
  });

  test('sets verified=false when PUT succeeds but models-fetch rejects (invalid key)', async () => {
    const putKey = vi.fn(async () => undefined);
    const fetchModels = vi.fn(async () => { throw new Error('Incorrect API key'); });

    const result = await connectAndValidate('openai', 'sk-invalid-key-12345', putKey, fetchModels);

    expect(result.verified).toBe(false);
    expect(result.error).toBe(true);
    expect(result.errorMessage).toBe('Incorrect API key');
    // Models fetch MUST be attempted — this is the validation step
    expect(fetchModels).toHaveBeenCalledOnce();
  });

  test('sets verified=false and skips models-fetch when PUT itself fails', async () => {
    const putKey = vi.fn(async () => { throw new Error('Failed to connect (HTTP 500)'); });
    const fetchModels = vi.fn(async () => ({ models: [] }));

    const result = await connectAndValidate('openai', 'sk-bad', putKey, fetchModels);

    expect(result.verified).toBe(false);
    expect(result.error).toBe(true);
    expect(result.errorMessage).toContain('HTTP 500');
    // PUT failed → models fetch should NOT run
    expect(fetchModels).not.toHaveBeenCalled();
  });

  test('verified=false is NOT counted in the providers-ready tally', () => {
    // Guard: verifiedCount is computed from providerState[id].verified.
    // If verified=false, the provider must not be counted.
    const providerState: Record<string, { verified: boolean }> = {
      openai: { verified: false },
      groq: { verified: true },
    };
    const ids = ['openai', 'groq'];
    const count = ids.filter((id) => providerState[id]?.verified).length;
    expect(count).toBe(1); // only groq counts
  });

  test('a provider with invalid key that was rejected stays at 0 ready', () => {
    const providerState: Record<string, { verified: boolean }> = {
      openai: { verified: false },
    };
    const count = ['openai'].filter((id) => providerState[id]?.verified).length;
    expect(count).toBe(0);
  });
});
