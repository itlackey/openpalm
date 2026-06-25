import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mergeEnvContent } from './env.js';
import { assertNoSecretLikeStackEnvKeys } from './secrets.js';
import { legacyStackEnvFile } from './home.js';

export type VoiceVarsConfig = {
  tts?: {
    enabled?: boolean;
    engine?: string;
    provider?: string;
    baseURL?: string;
    model?: string;
    voice?: string;
  };
  stt?: {
    enabled?: boolean;
    engine?: string;
    provider?: string;
    baseURL?: string;
    model?: string;
    language?: string;
  };
};

const OPENPALM_VOICE_TTS_MODEL = 'kokoro';
const OPENPALM_VOICE_STT_MODEL = 'whisper-1';
const OPENPALM_VOICE_DEFAULT_VOICE = 'bf_isabella';

function openpalmVoiceBaseURL(): string {
  const raw = (process.env.OP_VOICE_PORT_HOST ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  const port = Number.isFinite(n) && n > 0 ? n : 8880;
  return `http://127.0.0.1:${port}`;
}

function applyOpenPalmVoicePreset(
  section: NonNullable<VoiceVarsConfig['tts']> | NonNullable<VoiceVarsConfig['stt']>,
  kind: 'tts' | 'stt',
): void {
  if (section.engine !== 'openpalm-voice') return;
  if (!section.baseURL?.trim()) section.baseURL = openpalmVoiceBaseURL();
  if (!section.model?.trim()) {
    section.model = kind === 'tts' ? OPENPALM_VOICE_TTS_MODEL : OPENPALM_VOICE_STT_MODEL;
  }
  if (kind === 'tts' && !(section as NonNullable<VoiceVarsConfig['tts']>).voice?.trim()) {
    (section as NonNullable<VoiceVarsConfig['tts']>).voice = OPENPALM_VOICE_DEFAULT_VOICE;
  }
}

export function writeVoiceVars(config: VoiceVarsConfig, homeDir: string): void {
  const stackEnvPath = legacyStackEnvFile(homeDir);
  const base = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, 'utf-8') : '';
  const vars: Record<string, string> = {};

  const tts = config.tts ? { ...config.tts } : undefined;
  const stt = config.stt ? { ...config.stt } : undefined;

  if (tts) applyOpenPalmVoicePreset(tts, 'tts');
  if (stt) applyOpenPalmVoicePreset(stt, 'stt');

  if (tts?.enabled !== false) {
    if (tts?.engine) vars.OP_TTS_ENGINE = tts.engine;
    if (tts?.provider) vars.OP_TTS_PROVIDER = tts.provider;
    if (tts?.baseURL) vars.OP_TTS_BASE_URL = tts.baseURL;
    if (tts?.model) vars.OP_TTS_MODEL = tts.model;
    if (tts?.voice) vars.OP_TTS_VOICE = tts.voice;
  }
  if (stt?.enabled !== false) {
    if (stt?.engine) vars.OP_STT_ENGINE = stt.engine;
    if (stt?.provider) vars.OP_STT_PROVIDER = stt.provider;
    if (stt?.baseURL) vars.OP_STT_BASE_URL = stt.baseURL;
    if (stt?.model) vars.OP_STT_MODEL = stt.model;
    if (stt?.language) vars.OP_STT_LANGUAGE = stt.language;
  }

  if (Object.keys(vars).length === 0) return;
  assertNoSecretLikeStackEnvKeys(vars);

  let content = mergeEnvContent(base, vars, {
    sectionHeader: '# ── Voice Channel (TTS/STT) ──────────────────────────────────────────',
  });
  if (!content.endsWith('\n')) content += '\n';
  mkdirSync(dirname(stackEnvPath), { recursive: true, mode: 0o700 });
  writeFileSync(stackEnvPath, content, { mode: 0o600 });
}
