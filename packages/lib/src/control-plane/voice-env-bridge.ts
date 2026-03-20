/**
 * Voice environment bridge — maps TTS/STT capability assignments to
 * the env vars consumed by the voice channel container.
 *
 * The voice channel reads STT_BASE_URL, STT_API_KEY, STT_MODEL,
 * TTS_BASE_URL, TTS_API_KEY, TTS_MODEL, TTS_VOICE from its
 * environment (set via Docker Compose env substitution from secrets.env).
 *
 * When assignments change post-setup, this module builds the updated
 * env vars and writes them to secrets.env so they take effect on
 * the next container recreate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeEnvContent } from './env.js';
import { resolveApiKey } from './memory-config.js';
import type {
  CapabilityAssignments,
  CanonicalConnectionProfile,
  ControlPlaneState,
} from './types.js';

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
 * Normalize a base URL for the voice channel: strip trailing slashes
 * and trailing /v1 suffix, since the voice channel's STT/TTS providers
 * append /v1/audio/... themselves.
 */
function normalizeBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Build voice channel env vars from capability assignments and
 * connection profiles.
 *
 * - When an assignment has a `connectionId`, the corresponding
 *   profile's baseUrl and API key are resolved.
 * - When `connectionId` is absent (local engine), base URL and
 *   API key are not set.
 * - When the assignment is disabled or absent, all related env vars
 *   are set to empty string to clear any previous values.
 *
 * @param assignments  Current capability assignments
 * @param profiles     All connection profiles (used to resolve connectionId)
 * @param vaultDir     Vault directory path (used to resolve env: API key refs from user/user.env)
 * @returns Record of env var key → value to write to vault/user/user.env
 */
export function buildVoiceEnvVars(
  assignments: CapabilityAssignments,
  profiles: CanonicalConnectionProfile[],
  vaultDir: string,
): VoiceEnvVars {
  const vars: VoiceEnvVars = {};

  // ── TTS ──────────────────────────────────────────────────────────────
  const tts = assignments.tts;
  if (!tts || !tts.enabled) {
    // Disabled or absent: clear all TTS vars
    vars.TTS_BASE_URL = '';
    vars.TTS_API_KEY = '';
    vars.TTS_MODEL = '';
    vars.TTS_VOICE = '';
  } else if (tts.connectionId) {
    // Remote provider via connection profile
    const profile = profiles.find((p) => p.id === tts.connectionId);
    if (profile) {
      vars.TTS_BASE_URL = normalizeBaseUrl(profile.baseUrl);
      vars.TTS_API_KEY = profile.auth.mode === 'api_key' && profile.auth.apiKeySecretRef
        ? resolveApiKey(profile.auth.apiKeySecretRef, vaultDir)
        : '';
      if (tts.model) vars.TTS_MODEL = tts.model;
      if (tts.voice) vars.TTS_VOICE = tts.voice;
    } else {
      // Stale connectionId — clear to avoid using leftover values
      vars.TTS_BASE_URL = '';
      vars.TTS_API_KEY = '';
      vars.TTS_MODEL = '';
      vars.TTS_VOICE = '';
    }
  } else {
    // Local engine (no connectionId): the voice channel uses its own
    // compiled-in service URL for known local engines. We only pass
    // model/voice; base URL is intentionally cleared so the channel
    // falls back to its default for local providers.
    vars.TTS_BASE_URL = '';
    vars.TTS_API_KEY = '';
    if (tts.model) vars.TTS_MODEL = tts.model;
    if (tts.voice) vars.TTS_VOICE = tts.voice;
  }

  // ── STT ──────────────────────────────────────────────────────────────
  const stt = assignments.stt;
  if (!stt || !stt.enabled) {
    // Disabled or absent: clear all STT vars
    vars.STT_BASE_URL = '';
    vars.STT_API_KEY = '';
    vars.STT_MODEL = '';
  } else if (stt.connectionId) {
    // Remote provider via connection profile
    const profile = profiles.find((p) => p.id === stt.connectionId);
    if (profile) {
      vars.STT_BASE_URL = normalizeBaseUrl(profile.baseUrl);
      vars.STT_API_KEY = profile.auth.mode === 'api_key' && profile.auth.apiKeySecretRef
        ? resolveApiKey(profile.auth.apiKeySecretRef, vaultDir)
        : '';
      if (stt.model) vars.STT_MODEL = stt.model;
    } else {
      // Stale connectionId — clear to avoid using leftover values
      vars.STT_BASE_URL = '';
      vars.STT_API_KEY = '';
      vars.STT_MODEL = '';
    }
  } else {
    // Local engine — see TTS comment above
    vars.STT_BASE_URL = '';
    vars.STT_API_KEY = '';
    if (stt.model) vars.STT_MODEL = stt.model;
  }

  return vars;
}

/**
 * Write voice env vars to secrets.env and re-stage to artifacts.
 *
 * @returns true if any voice env vars were written
 */
export function applyVoiceEnvVars(
  state: ControlPlaneState,
  envVars: VoiceEnvVars,
): boolean {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return false;

  // Write to vault/user/user.env (voice env vars are user-level secrets)
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
 * Check whether the voice channel is installed — either as a legacy channel
 * overlay (channels/voice.yml) or as a component instance whose source
 * component is "voice".
 */
export function isVoiceChannelInstalled(openpalmHome: string): boolean {
  // Legacy channel overlay
  const configDir = `${openpalmHome}/config`;
  if (existsSync(`${configDir}/channels/voice.yml`)) return true;

  // Component system: check enabled instances for any voice-sourced component
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
