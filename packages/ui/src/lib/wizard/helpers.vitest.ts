import { describe, expect, test } from 'vitest';
import { resolveVoiceSide } from './helpers.js';

// ── resolveVoiceSide — voice single-source-of-truth ──────────────────────────
// These guard the fix for the displayed-vs-persisted split-brain (Issue #1):
// VoiceStep summary and ReviewStep must derive from the SAME resolution path.

describe('resolveVoiceSide', () => {
  test('explicit engine passes through regardless of enableVoice or fallback', () => {
    const result = resolveVoiceSide({ engine: 'openai-tts' }, false, 'browser-tts');
    expect(result).toEqual({ engine: 'openai-tts' });
  });

  test('explicit engine with extra fields passes through intact', () => {
    const side = { engine: 'openai-tts', model: 'tts-1', voice: 'alloy' };
    expect(resolveVoiceSide(side, false, 'browser-tts')).toBe(side);
  });

  test('empty engine + enableVoice=true → openpalm-voice', () => {
    expect(resolveVoiceSide({ engine: '' }, true, 'browser-tts')).toEqual({ engine: 'openpalm-voice' });
  });

  test('empty engine + enableVoice=false + fallback → fallback engine', () => {
    expect(resolveVoiceSide({ engine: '' }, false, 'browser-tts')).toEqual({ engine: 'browser-tts' });
  });

  test('empty engine + enableVoice=false + empty fallback → empty (persisted form)', () => {
    // The persisted form passes '' so that an untouched voice side is omitted
    // from the install payload (preserving any existing server config).
    expect(resolveVoiceSide({ engine: '' }, false, '')).toEqual({ engine: '' });
  });

  // ── OpenAI-as-default scenario (the original split-brain case) ───────────
  // When the wizard detects OpenAI, voiceDefaults.tts = 'openai-tts'. Passing
  // that as the fallback must produce OpenAI TTS on the displayed form — which
  // ReviewStep and VoiceStep now both receive.
  test('displayed form: no explicit engine + OpenAI detected → openai-tts default', () => {
    const displayed = resolveVoiceSide({ engine: '' }, false, 'openai-tts');
    expect(displayed).toEqual({ engine: 'openai-tts' });
  });

  test('persisted form: no explicit engine → empty (not openai-tts, not saved)', () => {
    // Review must show what will actually be saved; empty engine → not persisted.
    const persisted = resolveVoiceSide({ engine: '' }, false, '');
    expect(persisted.engine).toBe('');
  });

  // ── Consistency guarantee: displayed and persisted must agree on engine ───
  // When the user picks an explicit engine, both forms return the same engine.
  test('explicit engine: displayed and persisted agree', () => {
    const side = { engine: 'browser-stt' };
    const displayed = resolveVoiceSide(side, false, 'openai-stt');
    const persisted = resolveVoiceSide(side, false, '');
    expect(displayed.engine).toBe('browser-stt');
    expect(persisted.engine).toBe('browser-stt');
  });

  test('openpalm-voice active: displayed and persisted both resolve to openpalm-voice', () => {
    const side = { engine: '' };
    const displayed = resolveVoiceSide(side, true, 'browser-tts');
    const persisted = resolveVoiceSide(side, true, '');
    expect(displayed.engine).toBe('openpalm-voice');
    expect(persisted.engine).toBe('openpalm-voice');
  });
});
