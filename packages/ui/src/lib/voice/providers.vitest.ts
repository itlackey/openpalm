/**
 * Direct provider transport: target resolution from the client settings
 * (openpalm-voice via the advertised URL, openai-compatible via explicit
 * config), and the OpenAI-shaped transcribe/synthesize calls.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  _setAdvertisedVoiceUrlForTests,
  resolveSttTarget,
  resolveTtsTarget,
  synthesize,
  transcribe,
} from './providers.js';
import { saveVoiceSettings, type VoiceClientSettings } from './settings-store.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
  _setAdvertisedVoiceUrlForTests(null);
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  globalThis.fetch = originalFetch;
  _setAdvertisedVoiceUrlForTests(undefined);
});

function seed(settings: Partial<VoiceClientSettings>): void {
  saveVoiceSettings({
    version: 1,
    stt: { provider: 'disabled' },
    tts: { provider: 'disabled' },
    ...settings,
  });
}

describe('target resolution', () => {
  test('openpalm-voice resolves through the advertised pass-through with fixed models', async () => {
    _setAdvertisedVoiceUrlForTests('/voice');
    seed({ stt: { provider: 'openpalm-voice' }, tts: { provider: 'openpalm-voice' } });

    expect(await resolveSttTarget()).toEqual({
      baseURL: '/voice',
      model: 'whisper-1',
      language: undefined,
    });
    // `voice` is omitted so the host's configured default voice applies.
    expect(await resolveTtsTarget()).toEqual({
      baseURL: '/voice',
      model: 'kokoro',
      language: undefined,
    });
  });

  test('openpalm-voice ignores a stored baseURL — the advertisement is authoritative', async () => {
    _setAdvertisedVoiceUrlForTests('/voice');
    seed({
      stt: { provider: 'openpalm-voice', baseURL: 'http://evil.example' },
      tts: { provider: 'openpalm-voice', baseURL: 'http://evil.example' },
    });
    expect((await resolveSttTarget())?.baseURL).toBe('/voice');
    expect((await resolveTtsTarget())?.baseURL).toBe('/voice');
  });

  test('openpalm-voice without an advertisement resolves to no target', async () => {
    seed({ stt: { provider: 'openpalm-voice' }, tts: { provider: 'openpalm-voice' } });
    expect(await resolveSttTarget()).toBeNull();
    expect(await resolveTtsTarget()).toBeNull();
  });

  test('openai-compatible uses the configured endpoint and models', async () => {
    seed({
      stt: { provider: 'openai-compatible', baseURL: 'https://api.example', model: 'whisper-large', language: 'de' },
      tts: { provider: 'openai-compatible', baseURL: 'https://api.example', voice: 'alloy' },
    });
    expect(await resolveSttTarget()).toMatchObject({
      baseURL: 'https://api.example',
      model: 'whisper-large',
      language: 'de',
    });
    expect(await resolveTtsTarget()).toMatchObject({
      baseURL: 'https://api.example',
      model: 'tts-1',
      voice: 'alloy',
    });
  });

  test('browser/disabled providers have no server target', async () => {
    seed({ stt: { provider: 'browser' }, tts: { provider: 'disabled' } });
    expect(await resolveSttTarget()).toBeNull();
    expect(await resolveTtsTarget()).toBeNull();
  });
});

describe('transcribe', () => {
  test('POSTs OpenAI-shaped multipart to /v1/audio/transcriptions', async () => {
    seed({ stt: { provider: 'openai-compatible', baseURL: 'https://api.example/', model: 'whisper-1' } });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const text = await transcribe(new Blob(['bytes'], { type: 'audio/webm' }), { language: 'en' });
    expect(text).toBe('hello world');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  test('throws a friendly error when no provider is configured', async () => {
    seed({ stt: { provider: 'disabled' } });
    await expect(transcribe(new Blob(['x']))).rejects.toThrow(/not configured/i);
  });

  test('throws on a non-OK upstream', async () => {
    seed({ stt: { provider: 'openai-compatible', baseURL: 'https://api.example' } });
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(transcribe(new Blob(['x']))).rejects.toThrow(/HTTP 500/);
  });
});

describe('synthesize', () => {
  test('POSTs OpenAI-shaped JSON to the pass-through /v1/audio/speech', async () => {
    _setAdvertisedVoiceUrlForTests('/voice');
    seed({ tts: { provider: 'openpalm-voice' } });
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(['audio']), { status: 200, headers: { 'content-type': 'audio/wav' } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await synthesize('hello');
    expect(res?.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/voice/v1/audio/speech');
    // No `voice` field — the host's configured default voice applies.
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'kokoro',
      input: 'hello',
      response_format: 'wav',
    });
  });

  test('returns null (no fetch) when no server TTS provider is configured', async () => {
    seed({ tts: { provider: 'browser' } });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await synthesize('hello')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends the API key as a bearer header when stored', async () => {
    // The secret store runs over the in-memory backend in node (no IDB);
    // write through the same boot singleton the resolver reads.
    const { getSecretStore } = await import('$lib/connections/boot.js');
    await getSecretStore().set('ref-tts', { password: 'sk-test-123' });
    seed({ tts: { provider: 'openai-compatible', baseURL: 'https://api.example', secretRef: 'ref-tts' } });
    const fetchMock = vi.fn(async () => new Response(new Blob(['a']), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await synthesize('hello');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-123');
  });
});
