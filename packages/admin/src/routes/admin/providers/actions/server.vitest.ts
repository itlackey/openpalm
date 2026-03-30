import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

vi.mock('$lib/server/opencode-providers.js', () => {
  return {
    getCurrentConfig: vi.fn(async () => ({ provider: {} })),
    patchConfig: vi.fn(async () => {}),
    normalizeProviderConfig: vi.fn((entry: unknown) => entry),
    setProviderEnabled: vi.fn((c: Record<string, unknown>) => c),
    startOauthFlowAtBase: vi.fn(),
    finishOauthFlowAtBase: vi.fn(),
    actionSuccess: (message: string, providerId?: string, extra?: Record<string, unknown>) => ({
      ok: true, message, selectedProviderId: providerId, ...(extra ?? {}),
    }),
    actionFailure: (message: string, providerId?: string) => ({
      ok: false, message, selectedProviderId: providerId,
    }),
  };
});

vi.mock('$lib/server/opencode-auth-subprocess.js', () => ({
  ensureAuthServer: vi.fn(async () => 'http://localhost:9999'),
}));

import { getCurrentConfig, patchConfig } from '$lib/server/opencode-providers.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(body: unknown): Parameters<typeof POST>[0] {
  const url = new URL('http://localhost/admin/providers/actions');
  return {
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': 'admin-token',
        'x-request-id': 'req-test',
      },
      body: JSON.stringify(body),
    }),
    url,
    params: {},
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  rootDir = join(tmpdir(), `openpalm-prov-actions-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('POST /admin/providers/actions', () => {
  test('saveCustomProvider works without models', async () => {
    vi.mocked(getCurrentConfig).mockResolvedValueOnce({ provider: {} });

    const res = await POST(makeEvent({
      action: 'saveCustomProvider',
      providerId: 'my-provider',
      displayName: 'My Provider',
      baseURL: 'https://api.example.com/v1',
      modelsJson: '[]',
      headersJson: '[]',
      confirmOverwrite: 'false',
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify patchConfig was called with provider entry WITHOUT models key
    expect(vi.mocked(patchConfig)).toHaveBeenCalled();
    const patchedConfig = vi.mocked(patchConfig).mock.calls[0][0];
    const provider = (patchedConfig.provider as Record<string, Record<string, unknown>>)['my-provider'];
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider.name).toBe('My Provider');
    expect(provider.models).toBeUndefined();
  });

  test('saveCustomProvider includes models when provided', async () => {
    vi.mocked(getCurrentConfig).mockResolvedValueOnce({ provider: {} });

    const res = await POST(makeEvent({
      action: 'saveCustomProvider',
      providerId: 'my-provider',
      displayName: 'My Provider',
      baseURL: 'https://api.example.com/v1',
      modelsJson: JSON.stringify([{ id: 'gpt-4o', name: 'GPT-4o' }]),
      headersJson: '[]',
      confirmOverwrite: 'false',
    }));

    expect(res.status).toBe(200);
    const patchedConfig = vi.mocked(patchConfig).mock.calls[0][0];
    const provider = (patchedConfig.provider as Record<string, Record<string, unknown>>)['my-provider'];
    expect(provider.models).toBeDefined();
  });

  test('saveCustomProvider rejects missing baseURL', async () => {
    const res = await POST(makeEvent({
      action: 'saveCustomProvider',
      providerId: 'my-provider',
      displayName: 'My Provider',
      baseURL: '',
      modelsJson: '[]',
      headersJson: '[]',
      confirmOverwrite: 'false',
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test('saveCustomProvider rejects invalid provider ID', async () => {
    const res = await POST(makeEvent({
      action: 'saveCustomProvider',
      providerId: 'Bad Provider!',
      displayName: 'My Provider',
      baseURL: 'https://example.com',
      modelsJson: '[]',
      headersJson: '[]',
      confirmOverwrite: 'false',
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test('rejects unknown action', async () => {
    const res = await POST(makeEvent({ action: 'nope' }));
    expect(res.status).toBe(400);
  });
});
