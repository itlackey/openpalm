import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  fetchProviders,
  saveOpencodeModel,
  disconnectProvider,
  fetchHostStatus,
  startProviderOauth,
  oauthCallback,
  submitProviderApiKey,
  finishProviderOauth,
  registerCustomProvider,
  importHostProviders,
} from './providers.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function headerOf(init: RequestInit | undefined, key: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[key];
}

function mockFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('providers client — request shaping', () => {
  test('fetchProviders GETs /api/host/providers with the shared UI headers', async () => {
    const calls = mockFetch(200, { available: true, providers: [] });
    const state = await fetchProviders();
    expect(calls[0].url).toBe('/api/host/providers');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(headerOf(calls[0].init, 'x-requested-by')).toBe('ui');
    expect(headerOf(calls[0].init, 'x-request-id')).toBeTruthy();
    expect(state.available).toBe(true);
  });

  test('saveOpencodeModel POSTs the target field, coercing empty to null', async () => {
    const calls = mockFetch(200, { ok: true });
    await saveOpencodeModel('model', 'openai/gpt-4o');
    expect(calls[0].url).toBe('/api/assistant/model');
    expect(calls[0].init?.method).toBe('POST');
    expect(headerOf(calls[0].init, 'content-type')).toBe('application/json');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ model: 'openai/gpt-4o' });

    const calls2 = mockFetch(200, { ok: true });
    await saveOpencodeModel('small_model', '');
    expect(JSON.parse(calls2[0].init?.body as string)).toEqual({ small_model: null });
  });

  test('disconnectProvider DELETEs the URL-encoded auth endpoint', async () => {
    const calls = mockFetch(200, { ok: true });
    await disconnectProvider('a/b');
    expect(calls[0].url).toBe('/api/host/opencode/providers/a%2Fb/auth');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  test('fetchHostStatus GETs /api/host/providers/host-status', async () => {
    const calls = mockFetch(200, { detected: true, providerCount: 3, credentialCount: 2, configPath: null, authPath: null });
    const status = await fetchHostStatus();
    expect(calls[0].url).toBe('/api/host/providers/host-status');
    expect(status.providerCount).toBe(3);
  });

  test('startProviderOauth POSTs providerId + stringified methodIndex, returns body', async () => {
    const calls = mockFetch(200, { ok: true, oauth: { url: 'u', mode: 'code', providerId: 'p', methodIndex: 0 } });
    const result = await startProviderOauth('p', 0);
    expect(calls[0].url).toBe('/api/host/providers/oauth/start');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ providerId: 'p', methodIndex: '0' });
    expect(result.oauth?.url).toBe('u');
  });

  test('oauthCallback returns the raw Response and forwards the abort signal', async () => {
    const calls = mockFetch(200, {});
    const controller = new AbortController();
    const res = await oauthCallback('gh', 1, controller.signal);
    expect(res).toBeInstanceOf(Response);
    expect(calls[0].url).toBe('/api/host/providers/oauth/gh/callback');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ method: 1 });
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  test('submitProviderApiKey POSTs the api_key payload', async () => {
    const calls = mockFetch(200, { ok: true });
    await submitProviderApiKey('openai', 'sk-x');
    expect(calls[0].url).toBe('/api/host/opencode/providers/openai/auth');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ mode: 'api_key', apiKey: 'sk-x' });
  });

  test('finishProviderOauth POSTs providerId/methodIndex/code', async () => {
    const calls = mockFetch(200, { ok: true });
    await finishProviderOauth('p', 2, 'code123');
    expect(calls[0].url).toBe('/api/host/providers/oauth/finish');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ providerId: 'p', methodIndex: 2, code: 'code123' });
  });

  test('registerCustomProvider PATCHes /api/host/providers/{id} with the register-custom payload', async () => {
    const calls = mockFetch(200, { ok: true, selectedProviderId: 'my-p' });
    const result = await registerCustomProvider('my-p', { displayName: 'My P', baseURL: 'https://x/v1', apiKey: 'k' });
    expect(calls[0].url).toBe('/api/host/providers/my-p');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      kind: 'register-custom',
      displayName: 'My P',
      baseURL: 'https://x/v1',
      apiKey: 'k',
      modelsJson: '[]',
      headersJson: '[]',
      confirmOverwrite: 'false',
    });
    expect(result.selectedProviderId).toBe('my-p');
  });

  test('importHostProviders POSTs /api/host/providers/import-host', async () => {
    const calls = mockFetch(200, { ok: true, imported: { providers: 1, credentials: 2 }, conflicts: [] });
    const body = await importHostProviders();
    expect(calls[0].url).toBe('/api/host/providers/import-host');
    expect(calls[0].init?.method).toBe('POST');
    expect(body.imported.providers).toBe(1);
  });
});

describe('providers client — error propagation carries .status', () => {
  test('requireOk endpoints reject with an error whose .status is the HTTP status', async () => {
    mockFetch(500, { message: 'boom' });
    await expect(fetchProviders()).rejects.toMatchObject({ message: 'boom', status: 500 });
  });

  test('401 rejects with the shared "Sign-in required." error carrying status 401', async () => {
    mockFetch(401, {});
    await expect(fetchProviders()).rejects.toMatchObject({ message: 'Sign-in required.', status: 401 });
  });

  test('registerCustomProvider throws on a non-ok JSON body, surfacing message + status', async () => {
    mockFetch(409, { ok: false, message: 'already exists' });
    await expect(
      registerCustomProvider('p', { displayName: 'n', baseURL: 'u', apiKey: undefined })
    ).rejects.toMatchObject({ message: 'already exists', status: 409 });
  });

  test('importHostProviders rejects with status on a 401', async () => {
    mockFetch(401, {});
    await expect(importHostProviders()).rejects.toMatchObject({ status: 401 });
  });
});
