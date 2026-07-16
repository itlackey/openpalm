/**
 * Client-owned voice settings persistence: round-trip, shape validation, and
 * graceful handling of missing/corrupt storage.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadVoiceSettings, saveVoiceSettings, type VoiceClientSettings } from './settings-store.js';

const KEY = 'openpalm.voice.settings';

beforeEach(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('voice settings store', () => {
  test('round-trips a full settings record', () => {
    const settings: VoiceClientSettings = {
      version: 1,
      stt: { provider: 'openai-compatible', baseURL: 'http://stt.example', model: 'whisper-1', language: 'en', secretRef: 'ref-1' },
      tts: { provider: 'openpalm-voice', voice: 'bf_isabella' },
    };
    saveVoiceSettings(settings);
    expect(loadVoiceSettings()).toEqual(settings);
  });

  test('null when nothing was ever saved', () => {
    expect(loadVoiceSettings()).toBeNull();
  });

  test('null for corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(loadVoiceSettings()).toBeNull();
  });

  test('null for an unknown provider id', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, stt: { provider: 'telepathy' }, tts: { provider: 'browser' } })
    );
    expect(loadVoiceSettings()).toBeNull();
  });

  test('drops non-string / empty extras on load', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        stt: { provider: 'browser', baseURL: 42, language: '' },
        tts: { provider: 'disabled' },
      })
    );
    expect(loadVoiceSettings()).toEqual({
      version: 1,
      stt: { provider: 'browser' },
      tts: { provider: 'disabled' },
    });
  });
});
