/**
 * Voice environment bridge — maps TTS/STT capability settings to
 * the env vars consumed by the voice channel container.
 *
 * In v2, TTS/STT config lives in stack.yaml capabilities (StackSpecTts/StackSpecStt).
 * API keys come from vault/user/user.env via provider key mappings.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeEnvContent } from './env.js';
import type { StackSpecTts, StackSpecStt } from './stack-spec.js';
import type { ControlPlaneState } from './types.js';

/** All env var keys the voice channel reads for TTS/STT. */
const VOICE_ENV_KEYS = [
  'STT_BASE_URL',
  'STT_API_KEY',
  'STT_MODEL',
  'TTS_BASE_URL',
  'TTS_API_KEY',
  'TTS_MODEL',
  'TTS_VOICE',
] as const;

export type VoiceEnvVars = Partial<Record<(typeof VOICE_ENV_KEYS)[number], string>>;

/**
 * Build voice channel env vars from TTS/STT capabilities.
 */
export function buildVoiceEnvVars(
  tts?: StackSpecTts,
  stt?: StackSpecStt,
): VoiceEnvVars {
  const vars: VoiceEnvVars = {};

  // ── TTS ──────────────────────────────────────────────────────────────
  if (!tts || !tts.enabled) {
    vars.TTS_BASE_URL = '';
    vars.TTS_API_KEY = '';
    vars.TTS_MODEL = '';
    vars.TTS_VOICE = '';
  } else {
    vars.TTS_BASE_URL = '';
    vars.TTS_API_KEY = '';
    if (tts.model) vars.TTS_MODEL = tts.model;
    if (tts.voice) vars.TTS_VOICE = tts.voice;
  }

  // ── STT ──────────────────────────────────────────────────────────────
  if (!stt || !stt.enabled) {
    vars.STT_BASE_URL = '';
    vars.STT_API_KEY = '';
    vars.STT_MODEL = '';
  } else {
    vars.STT_BASE_URL = '';
    vars.STT_API_KEY = '';
    if (stt.model) vars.STT_MODEL = stt.model;
  }

  return vars;
}

/**
 * Write voice env vars to vault/user/user.env.
 *
 * @returns true if any voice env vars were written
 */
export function applyVoiceEnvVars(
  state: ControlPlaneState,
  envVars: VoiceEnvVars,
): boolean {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return false;

  const secretsPath = `${state.vaultDir}/user/user.env`;
  let existing = '';
  if (existsSync(secretsPath)) {
    try {
      existing = readFileSync(secretsPath, 'utf-8');
    } catch {
      // start fresh
    }
  }

  const updates: Record<string, string> = {};
  for (const [key, value] of entries) {
    updates[key] = value ?? '';
  }

  let result = mergeEnvContent(existing, updates, { uncomment: true });
  if (!result.endsWith('\n')) result += '\n';
  writeFileSync(secretsPath, result);

  return true;
}

/**
 * Check whether the voice channel is installed.
 */
export function isVoiceChannelInstalled(openpalmHome: string): boolean {
  const configDir = `${openpalmHome}/config`;
  if (existsSync(`${configDir}/channels/voice.yml`)) return true;

  try {
    const enabledPath = `${openpalmHome}/data/components/enabled.json`;
    if (!existsSync(enabledPath)) return false;
    const enabled = JSON.parse(readFileSync(enabledPath, 'utf-8'));
    return Array.isArray(enabled) && enabled.some(
      (i: { component?: string; enabled?: boolean }) =>
        i.component === 'voice' && i.enabled !== false
    );
  } catch {
    return false;
  }
}
