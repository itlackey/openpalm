import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const resolveSetupOpencodeTarget = vi.fn();
vi.mock('./setup-target.js', () => ({ resolveSetupOpencodeTarget }));

const opencodeFetch = vi.fn();
vi.mock('./http.js', () => ({ opencodeFetch }));

// Dynamically imported per test (after vi.resetModules()) — see setup-target.vitest.ts
// for why a static top-level import here would TDZ-fail against the mocks above.
async function loadModule() {
  return await import('./catalog.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSetupProviderPage (W1)', () => {
  test('reports unavailable without ever calling OpenCode when no target resolves', async () => {
    resolveSetupOpencodeTarget.mockResolvedValue(null);

    const { loadSetupProviderPage } = await loadModule();
    const result = await loadSetupProviderPage();

    expect(result).toEqual({ available: false, providers: [] });
    expect(opencodeFetch).not.toHaveBeenCalled();
  });

  test('fetches against the resolved target (the wizard instance on a fresh host)', async () => {
    const target = { url: 'http://127.0.0.1:40000' };
    resolveSetupOpencodeTarget.mockResolvedValue(target);
    opencodeFetch.mockImplementation(async (path: string) => {
      if (path === '/provider') return { all: [{ id: 'openai', name: 'OpenAI' }], default: {}, connected: [] };
      if (path === '/provider/auth') return {};
      throw new Error(`unexpected path ${path}`);
    });

    const { loadSetupProviderPage } = await loadModule();
    const result = await loadSetupProviderPage();

    expect(result.available).toBe(true);
    // Both catalog calls were made against the resolved target, not whatever
    // opencodeFetch's own default (the deployed assistant) would have been.
    expect(opencodeFetch).toHaveBeenCalledWith('/provider', undefined, target);
    expect(opencodeFetch).toHaveBeenCalledWith('/provider/auth', undefined, target);
  });
});
