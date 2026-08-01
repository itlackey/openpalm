import { beforeEach, describe, expect, test, vi } from 'vitest';
import { loadSetupProviderPage } from './catalog.js';

const { resolveSetupOpencodeTarget, opencodeFetch } = vi.hoisted(() => ({
  resolveSetupOpencodeTarget: vi.fn(),
  opencodeFetch: vi.fn(),
}));

vi.mock('./setup-target.js', () => ({ resolveSetupOpencodeTarget }));
vi.mock('./http.js', () => ({ opencodeFetch }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadSetupProviderPage (W1)', () => {
  test('reports unavailable without ever calling OpenCode when no target resolves', async () => {
    resolveSetupOpencodeTarget.mockResolvedValue(null);

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

    const result = await loadSetupProviderPage();

    expect(result.available).toBe(true);
    // Both catalog calls were made against the resolved target, not whatever
    // opencodeFetch's own default (the deployed assistant) would have been.
    expect(opencodeFetch).toHaveBeenCalledWith('/provider', undefined, target);
    expect(opencodeFetch).toHaveBeenCalledWith('/provider/auth', undefined, target);
  });
});
