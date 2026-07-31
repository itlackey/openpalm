import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  fetchVoiceProfiles, fetchProviderModels, ensureOpenCode,
  completeSetup, fetchDeployStatus, fetchSetupStatus, importHost,
} from './setup-api.js';
import type { SetupPayload } from './setup/payload.js';

interface Call { url: string; init: RequestInit | undefined; }

function mockFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setupRequest shaping', () => {
  test('GET sends no body and no Content-Type header', async () => {
    const calls = mockFetch(200, { profiles: [] });
    await fetchVoiceProfiles();
    expect(calls[0].url).toBe('/api/setup/voice-profiles');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[0].init?.headers).toBeUndefined();
  });

  test('POST with no body sends no Content-Type header', async () => {
    const calls = mockFetch(200, { ok: true });
    await ensureOpenCode();
    expect(calls[0].url).toBe('/api/setup/opencode/ensure');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toBeUndefined();
  });

  test('POST with body sets Content-Type and serializes body', async () => {
    const calls = mockFetch(200, { models: ['m'] });
    await fetchProviderModels('openai', { apiKey: 'k', baseUrl: 'u' });
    expect(calls[0].url).toBe('/api/setup/models/openai');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ apiKey: 'k', baseUrl: 'u' });
  });

  test('provider id is URL-encoded', async () => {
    const calls = mockFetch(200, { models: [] });
    await fetchProviderModels('a/b', { apiKey: '', baseUrl: '' });
    expect(calls[0].url).toBe('/api/setup/models/a%2Fb');
  });
});

describe('result mapping', () => {
  test('null-on-not-ok endpoints return null for non-2xx', async () => {
    mockFetch(500, {});
    expect(await fetchVoiceProfiles()).toBeNull();
  });

  test('fetchDeployStatus returns { ok:false, data:null } on non-ok', async () => {
    mockFetch(503, {});
    expect(await fetchDeployStatus()).toEqual({ ok: false, data: null });
  });

  test('fetchDeployStatus returns { ok:true, data } on ok', async () => {
    mockFetch(200, { deploying: true });
    expect(await fetchDeployStatus()).toEqual({ ok: true, data: { deploying: true } });
  });

  test('completeSetup exposes ok flag and parsed body', async () => {
    mockFetch(503, { ok: false, message: 'docker down' });
    const r = await completeSetup({} as SetupPayload);
    expect(r.ok).toBe(false);
    expect(r.data.message).toBe('docker down');
  });

  test('importHost returns { ok, data }', async () => {
    mockFetch(200, { ok: true, importedProviders: ['openai'] });
    const r = await importHost();
    expect(r.ok).toBe(true);
    expect(r.data?.importedProviders).toEqual(['openai']);
  });

  test('fetchSetupStatus parses the body regardless of status', async () => {
    mockFetch(200, { setupComplete: true });
    expect(await fetchSetupStatus()).toEqual({ setupComplete: true });
  });
});

describe('fetchProviderModels error semantics', () => {
  test('throws the server error message on non-ok', async () => {
    mockFetch(400, { error: 'bad key' });
    await expect(fetchProviderModels('openai', { apiKey: '', baseUrl: '' })).rejects.toThrow('bad key');
  });

  test('throws HTTP fallback when no server error message', async () => {
    mockFetch(502, {});
    await expect(fetchProviderModels('openai', { apiKey: '', baseUrl: '' })).rejects.toThrow('HTTP 502');
  });

  test('W15: prefers the human `message` over the machine `error` code on a 500', async () => {
    // Matches /api/setup/models/[provider]'s catch-all: { error: 'model_fetch_failed', message: <human text> }.
    mockFetch(500, { error: 'model_fetch_failed', message: 'Ollama is not reachable at http://localhost:11434' });
    await expect(fetchProviderModels('ollama', { apiKey: '', baseUrl: '' }))
      .rejects.toThrow('Ollama is not reachable at http://localhost:11434');
  });

  test('throws on a 200 body with status recoverable_error', async () => {
    mockFetch(200, { status: 'recoverable_error', error: 'try again' });
    await expect(fetchProviderModels('openai', { apiKey: '', baseUrl: '' })).rejects.toThrow('try again');
  });

  test('returns models on success', async () => {
    mockFetch(200, { models: ['gpt-4o'] });
    expect(await fetchProviderModels('openai', { apiKey: '', baseUrl: '' })).toEqual({ models: ['gpt-4o'] });
  });
});
