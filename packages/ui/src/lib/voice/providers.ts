/**
 * Browser-side speech-provider transport.
 *
 * The chat client owns its TTS/STT provider choice and calls the provider's
 * OpenAI-shaped /v1/audio endpoints from the browser — there is no
 * config-holding relay anymore (the old /api/speak and /api/transcribe
 * proxies read host-global stack.env config, which conflated per-device
 * preference with host state). Two transports:
 *
 *   - 'openpalm-voice'    → the SAME-ORIGIN `/voice` pass-through the host
 *                           advertises in the runtime handshake. Same-origin
 *                           means no CORS and no exposed container port; the
 *                           session cookie rides along automatically
 *                           (fetch's default same-origin credentials mode).
 *   - 'openai-compatible' → the user's configured endpoint, called directly
 *                           with the API key held in the browser's encrypted
 *                           secret store — the same trust model as
 *                           connection passwords.
 *
 * "OpenPalm Voice" resolution: the handshake's `voice.url` (present when the
 * host process can serve the pass-through and the addon is enabled). We
 * fetch the handshake lazily (once per page load; `refreshAdvertisedVoiceUrl`
 * re-probes) instead of reading the reactive runtime-context store, so
 * resolution works regardless of layout-mount ordering and in non-component
 * callers.
 */

import { getSecretStore } from '$lib/connections/boot.js';
import {
  loadVoiceSettings,
  type VoiceProviderId,
  type VoiceSttSettings,
  type VoiceTtsSettings,
} from './settings-store.js';

const OPENPALM_VOICE_TTS_MODEL = 'kokoro';
const OPENPALM_VOICE_STT_MODEL = 'whisper-1';
const UPSTREAM_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

// ── OpenPalm Voice advertisement ─────────────────────────────────────────

let advertisedUrl: string | null | undefined;
let advertisedFetch: Promise<string | null> | null = null;

async function fetchAdvertisedUrl(): Promise<string | null> {
  try {
    const res = await fetch('/api/runtime', {
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { voice?: { url?: unknown } };
    return typeof data.voice?.url === 'string' && data.voice.url ? data.voice.url : null;
  } catch {
    return null;
  }
}

/**
 * The host's advertised voice-container URL, or null when the voice addon is
 * disabled / the handshake is unreachable. Cached for the page's lifetime;
 * concurrent first callers share one fetch.
 */
export function advertisedVoiceUrl(): Promise<string | null> {
  if (advertisedUrl !== undefined) return Promise.resolve(advertisedUrl);
  advertisedFetch ??= fetchAdvertisedUrl().then((url) => {
    advertisedUrl = url;
    advertisedFetch = null;
    return url;
  });
  return advertisedFetch;
}

/** Drop the cached advertisement (the voice settings UI re-probes after the
 * admin toggles the addon). */
export function refreshAdvertisedVoiceUrl(): Promise<string | null> {
  advertisedUrl = undefined;
  advertisedFetch = null;
  return advertisedVoiceUrl();
}

/** Test-only: seed/clear the cached advertisement without network. */
export function _setAdvertisedVoiceUrlForTests(url: string | null | undefined): void {
  advertisedUrl = url;
  advertisedFetch = null;
}

// ── Provider target resolution ───────────────────────────────────────────

/** A concrete server-side speech endpoint to call directly. */
export type ServerVoiceTarget = {
  baseURL: string;
  model: string;
  voice?: string;
  language?: string;
  apiKey?: string;
};

async function apiKeyFor(secretRef: string | undefined): Promise<string | undefined> {
  if (!secretRef) return undefined;
  try {
    const material = await getSecretStore().get(secretRef);
    return material?.password || undefined;
  } catch {
    return undefined;
  }
}

async function resolveTarget(
  section: VoiceSttSettings | VoiceTtsSettings | undefined,
  kind: 'stt' | 'tts'
): Promise<ServerVoiceTarget | null> {
  const provider: VoiceProviderId | undefined = section?.provider;
  if (provider === 'openpalm-voice') {
    // Always the advertised same-origin pass-through — there is nothing to
    // configure. Model is fixed by the container; `voice` is deliberately
    // omitted so the host's configured default (OP_VOICE_KOKORO_VOICE)
    // applies.
    const url = await advertisedVoiceUrl();
    if (!url) return null;
    return {
      baseURL: url,
      model: kind === 'tts' ? OPENPALM_VOICE_TTS_MODEL : OPENPALM_VOICE_STT_MODEL,
      language: kind === 'stt' ? (section as VoiceSttSettings | undefined)?.language : undefined,
    };
  }
  if (provider === 'openai-compatible') {
    const baseURL = section?.baseURL?.trim();
    if (!baseURL) return null;
    return {
      baseURL,
      model: section?.model?.trim() || (kind === 'tts' ? 'tts-1' : 'whisper-1'),
      voice: kind === 'tts' ? (section as VoiceTtsSettings | undefined)?.voice?.trim() : undefined,
      language: kind === 'stt' ? (section as VoiceSttSettings | undefined)?.language : undefined,
      apiKey: await apiKeyFor(section?.secretRef),
    };
  }
  return null; // browser / disabled — no server target
}

export function resolveSttTarget(): Promise<ServerVoiceTarget | null> {
  return resolveTarget(loadVoiceSettings()?.stt, 'stt');
}

export function resolveTtsTarget(): Promise<ServerVoiceTarget | null> {
  return resolveTarget(loadVoiceSettings()?.tts, 'tts');
}

// ── Direct provider calls ────────────────────────────────────────────────

function joinBase(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`;
}

/**
 * Transcribe a recorded Blob against the configured STT provider
 * (OpenAI-shape POST /v1/audio/transcriptions). Throws with a
 * human-readable message on any failure, including "no provider".
 */
export async function transcribe(
  blob: Blob,
  opts?: { language?: string; prompt?: string }
): Promise<string> {
  const target = await resolveSttTarget();
  if (!target) {
    throw new Error('Speech-to-text is not configured. Pick a provider in voice settings.');
  }

  const form = new FormData();
  const filename = (blob as File).name || 'recording.webm';
  form.append('file', blob, filename);
  form.append('model', target.model);
  form.append('response_format', 'json');
  const language = opts?.language?.trim() || target.language?.trim();
  if (language) form.append('language', language);
  if (opts?.prompt?.trim()) form.append('prompt', opts.prompt.trim());

  const headers: Record<string, string> = {};
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;

  let res: Response;
  try {
    res = await fetch(joinBase(target.baseURL, '/v1/audio/transcriptions'), {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Could not reach the speech-to-text endpoint.');
  }
  if (!res.ok) {
    throw new Error(`Transcription failed (HTTP ${res.status}).`);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error('The speech-to-text endpoint returned a non-JSON response.');
  }
  const text = (payload as { text?: unknown })?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Synthesize speech for `text` against the configured TTS provider
 * (OpenAI-shape POST /v1/audio/speech). Returns the raw Response (audio
 * bytes on 200) or null when no server-side TTS provider is configured;
 * network failures reject.
 */
export async function synthesize(
  text: string,
  opts?: { format?: string }
): Promise<Response | null> {
  const target = await resolveTtsTarget();
  if (!target) return null;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;

  return fetch(joinBase(target.baseURL, '/v1/audio/speech'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: target.model,
      input: text,
      ...(target.voice ? { voice: target.voice } : {}),
      // WAV is universal across browsers and Electron builds; mp3 fails on
      // some Linux/Firefox configs and bare Electron without ffmpeg.
      response_format: opts?.format ?? 'wav',
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

/** Best-effort reachability probe of a speech endpoint (GET /v1/models). */
export async function probeVoiceEndpoint(baseURL: string): Promise<boolean> {
  try {
    const res = await fetch(joinBase(baseURL, '/v1/models'), {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
