import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVoiceVars } from './voice-env.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openpalm-voice-env-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('writeVoiceVars', () => {
  let stackDir = '';
  let stackEnv = '';

  beforeEach(() => {
    stackDir = join(tempDir, 'config', 'stack');
    stackEnv = join(tempDir, 'knowledge', 'env', 'stack.env');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(join(tempDir, 'knowledge', 'env'), { recursive: true });
  });

  test('writes TTS vars to stack.env', () => {
    writeFileSync(stackEnv, '# stack env\n');

    writeVoiceVars({
      tts: { baseURL: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy' },
    }, tempDir);

    const content = readFileSync(stackEnv, 'utf-8');
    expect(content).toContain('OP_TTS_BASE_URL=https://tts.example.com/v1');
    expect(content).toContain('OP_TTS_MODEL=tts-1');
    expect(content).toContain('OP_TTS_VOICE=alloy');
  });

  test('writes STT vars to stack.env', () => {
    writeFileSync(stackEnv, '# stack env\n');

    writeVoiceVars({
      stt: { baseURL: 'https://stt.example.com/v1', model: 'whisper-1', language: 'en' },
    }, tempDir);

    const content = readFileSync(stackEnv, 'utf-8');
    expect(content).toContain('OP_STT_BASE_URL=https://stt.example.com/v1');
    expect(content).toContain('OP_STT_MODEL=whisper-1');
    expect(content).toContain('OP_STT_LANGUAGE=en');
  });

  test('creates stack.env if it does not exist', () => {
    writeVoiceVars({
      tts: { baseURL: 'https://tts.example.com/v1', model: 'tts-1' },
    }, tempDir);

    const content = readFileSync(stackEnv, 'utf-8');
    expect(content).toContain('OP_TTS_BASE_URL=https://tts.example.com/v1');
  });

  test('is a no-op when no vars are provided', () => {
    writeFileSync(stackEnv, 'EXISTING=value\n');

    writeVoiceVars({}, tempDir);

    expect(readFileSync(stackEnv, 'utf-8')).toBe('EXISTING=value\n');
  });

  test('auto-fills baseURL/model/voice for openpalm-voice engine', () => {
    writeVoiceVars({
      tts: { engine: 'openpalm-voice' },
      stt: { engine: 'openpalm-voice' },
    }, tempDir);

    const content = readFileSync(stackEnv, 'utf-8');
    expect(content).toContain('OP_TTS_ENGINE=openpalm-voice');
    expect(content).toMatch(/OP_TTS_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
    expect(content).toContain('OP_TTS_MODEL=kokoro');
    expect(content).toContain('OP_TTS_VOICE=bf_isabella');
    expect(content).toContain('OP_STT_ENGINE=openpalm-voice');
    expect(content).toMatch(/OP_STT_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
    expect(content).toContain('OP_STT_MODEL=whisper-1');
  });

  test('does not overwrite explicit baseURL for openpalm-voice', () => {
    writeVoiceVars({
      tts: { engine: 'openpalm-voice', baseURL: 'http://192.168.1.50:8880' },
    }, tempDir);

    expect(readFileSync(stackEnv, 'utf-8')).toContain('OP_TTS_BASE_URL=http://192.168.1.50:8880');
  });
});
