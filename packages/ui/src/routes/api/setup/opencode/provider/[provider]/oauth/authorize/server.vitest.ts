import { beforeEach, describe, expect, test, vi } from 'vitest';

const { resolveSetupOpencodeTarget, startProviderOAuth } = vi.hoisted(() => ({
  resolveSetupOpencodeTarget: vi.fn(),
  startProviderOAuth: vi.fn(),
}));

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    createOpenCodeClient: vi.fn(() => ({ startProviderOAuth })),
  };
});
vi.mock('$lib/server/opencode/setup-target.js', () => ({ resolveSetupOpencodeTarget }));

import { POST } from './+server.js';

function event(provider: string, body: unknown): Parameters<typeof POST>[0] {
  return {
    params: { provider },
    request: new Request(`http://127.0.0.1/api/setup/opencode/provider/${provider}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

describe('POST setup OpenCode OAuth authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSetupOpencodeTarget.mockResolvedValue({
      source: 'wizard',
      url: 'http://127.0.0.1:40123',
    });
    startProviderOAuth.mockResolvedValue({
      ok: true,
      data: { url: 'https://provider.test/authorize', method: 'auto' },
    });
  });

  test('returns the selected non-secret target source', async () => {
    const response = await POST(event('google', { method: 2 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      url: 'https://provider.test/authorize',
      method: 'auto',
      source: 'wizard',
    });
  });
});
