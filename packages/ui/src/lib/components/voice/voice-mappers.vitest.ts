import { describe, expect, test } from 'vitest';
import {
  EMPTY_SECTION,
  normalizeEngine,
  readSection,
  buildPayload,
} from './voice-mappers.js';

describe('normalizeEngine', () => {
  test('non-string input yields empty', () => {
    expect(normalizeEngine(undefined, 'tts')).toBe('');
    expect(normalizeEngine(123, 'stt')).toBe('');
  });

  test('openpalm-voice passes through', () => {
    expect(normalizeEngine('openpalm-voice', 'tts')).toBe('openpalm-voice');
    expect(normalizeEngine('openpalm-voice', 'stt')).toBe('openpalm-voice');
  });

  test('browser variants normalize to browser per kind', () => {
    expect(normalizeEngine('browser', 'tts')).toBe('browser');
    expect(normalizeEngine('browser', 'stt')).toBe('browser');
    expect(normalizeEngine('browser-tts', 'tts')).toBe('browser');
    expect(normalizeEngine('browser-stt', 'stt')).toBe('browser');
    // Mismatched kind is not a browser alias → treated as remote.
    expect(normalizeEngine('browser-stt', 'tts')).toBe('remote');
  });

  test('empty and skip- prefixes yield empty', () => {
    expect(normalizeEngine('', 'tts')).toBe('');
    expect(normalizeEngine('skip-tts', 'tts')).toBe('');
    expect(normalizeEngine('skip-anything', 'stt')).toBe('');
  });

  test('any other engine id is remote', () => {
    expect(normalizeEngine('kokoro', 'tts')).toBe('remote');
    expect(normalizeEngine('openai-tts', 'tts')).toBe('remote');
    expect(normalizeEngine('whisper-local', 'stt')).toBe('remote');
  });
});

describe('readSection', () => {
  test('missing / non-object raw yields an empty section', () => {
    expect(readSection(undefined, 'tts')).toEqual(EMPTY_SECTION());
    expect(readSection(null as unknown as undefined, 'stt')).toEqual(EMPTY_SECTION());
  });

  test('reads shared fields and tts-only voice', () => {
    const s = readSection(
      { engine: 'kokoro', baseURL: 'http://x/v1', model: 'tts-1', voice: 'alloy', language: 'en' },
      'tts',
    );
    expect(s.engine).toBe('remote');
    expect(s.baseURL).toBe('http://x/v1');
    expect(s.model).toBe('tts-1');
    expect(s.voice).toBe('alloy');
    // language is stt-only; ignored for tts.
    expect(s.language).toBe('');
  });

  test('reads stt-only language and ignores voice', () => {
    const s = readSection(
      { engine: 'whisper-1', baseURL: 'http://y/v1', model: 'whisper-1', voice: 'alloy', language: 'fr' },
      'stt',
    );
    expect(s.engine).toBe('remote');
    expect(s.language).toBe('fr');
    expect(s.voice).toBe('');
  });
});

describe('buildPayload', () => {
  test('no engine → undefined', () => {
    expect(buildPayload(EMPTY_SECTION(), 'tts')).toBeUndefined();
  });

  test('remote tts includes baseURL/model/voice', () => {
    expect(
      buildPayload(
        { engine: 'remote', baseURL: 'http://x/v1', model: 'tts-1', voice: 'alloy', language: 'en' },
        'tts',
      ),
    ).toEqual({ enabled: true, engine: 'remote', baseURL: 'http://x/v1', model: 'tts-1', voice: 'alloy' });
  });

  test('remote stt includes language, not voice', () => {
    expect(
      buildPayload(
        { engine: 'remote', baseURL: 'http://y/v1', model: 'whisper-1', voice: 'alloy', language: 'fr' },
        'stt',
      ),
    ).toEqual({ enabled: true, engine: 'remote', baseURL: 'http://y/v1', model: 'whisper-1', language: 'fr' });
  });

  test('browser stt carries language only', () => {
    expect(
      buildPayload({ engine: 'browser', baseURL: '', model: '', voice: '', language: 'en-US' }, 'stt'),
    ).toEqual({ enabled: true, engine: 'browser', language: 'en-US' });
  });

  test('browser tts carries no extra fields', () => {
    expect(
      buildPayload({ engine: 'browser', baseURL: '', model: '', voice: 'x', language: 'en' }, 'tts'),
    ).toEqual({ enabled: true, engine: 'browser' });
  });

  test('openpalm-voice carries no endpoint fields', () => {
    expect(
      buildPayload(
        { engine: 'openpalm-voice', baseURL: 'http://x', model: 'm', voice: 'v', language: 'l' },
        'tts',
      ),
    ).toEqual({ enabled: true, engine: 'openpalm-voice' });
  });
});
