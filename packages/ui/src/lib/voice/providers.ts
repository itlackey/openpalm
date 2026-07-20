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
// Bumped by refresh/test seeding so an in-flight fetch that loses the race
// cannot clobber a newer value.
let advertisedGeneration = 0;

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

function startAdvertisedFetch(): Promise<string | null> {
  const generation = advertisedGeneration;
  const inFlight = fetchAdvertisedUrl().then((url) => {
    if (generation === advertisedGeneration) {
      advertisedUrl = url;
      advertisedFetch = null;
    }
    return url;
  });
  advertisedFetch = inFlight;
  return inFlight;
}

/**
 * The host's advertised voice pass-through URL, or null when the voice addon
 * is disabled / the handshake is unreachable. Cached between refreshes;
 * concurrent callers share one fetch. `initVoice` refreshes on every run (a
 * cheap same-origin GET), so an addon toggle is picked up on the next chat
 * mount without a hard reload.
 */
export function advertisedVoiceUrl(): Promise<string | null> {
  if (advertisedUrl !== undefined) return Promise.resolve(advertisedUrl);
  return advertisedFetch ?? startAdvertisedFetch();
}

/** Drop the cached advertisement and re-probe (initVoice, the voice settings
 * UI, and the Add-ons tab after a toggle). */
export function refreshAdvertisedVoiceUrl(): Promise<string | null> {
  advertisedGeneration++;
  advertisedUrl = undefined;
  return startAdvertisedFetch();
}

/** Test-only: seed/clear the cached advertisement without network. */
export function _setAdvertisedVoiceUrlForTests(url: string | null | undefined): void {
  advertisedGeneration++;
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

/**
 * The advertised OpenPalm Voice pass-through target, or null when the host
 * offers none. Model is fixed by the container; `voice` is deliberately
 * omitted so the host's configured default (OP_VOICE_KOKORO_VOICE) applies.
 */
async function openpalmVoiceTarget(
  section: VoiceSttSettings | VoiceTtsSettings | undefined,
  kind: 'stt' | 'tts'
): Promise<ServerVoiceTarget | null> {
  const url = await advertisedVoiceUrl();
  if (!url) return null;
  return {
    baseURL: url,
    model: kind === 'tts' ? OPENPALM_VOICE_TTS_MODEL : OPENPALM_VOICE_STT_MODEL,
    language: kind === 'stt' ? (section as VoiceSttSettings | undefined)?.language : undefined,
  };
}

async function resolveTarget(
  section: VoiceSttSettings | VoiceTtsSettings | undefined,
  kind: 'stt' | 'tts'
): Promise<ServerVoiceTarget | null> {
  const provider: VoiceProviderId | undefined = section?.provider;
  // No saved settings on this device (fresh browser): mirror initVoice's
  // zero-config default — prefer the advertised OpenPalm Voice pass-through
  // when the host offers one. Without this the advertised default engine
  // (openpalm-voice) has no target, so transcribe()/synthesize() no-op and
  // the "works out of the box" path is dead until the user opens /connections
  // and saves. A saved section with provider 'browser'/'disabled' is a
  // deliberate choice and stays null (handled by the browser path elsewhere).
  if (!provider) return openpalmVoiceTarget(section, kind);
  if (provider === 'openpalm-voice') {
    return openpalmVoiceTarget(section, kind);
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

/**
 * Resolve the OpenAI-shaped API base from the user's configured endpoint.
 *
 * OpenAI and every compatible service (OpenRouter, Groq, LM Studio, vLLM,
 * Ollama, …) document a `base_url` that already ends in a version segment —
 * almost always `/v1`. We respect a version the user supplied and add `/v1`
 * only when absent, so pasting the provider's documented base URL Just
 * Works whether or not it includes `/v1` (no double `/v1/v1`, no hint to
 * remember). The openpalm-voice pass-through base (`/voice`) has no version,
 * so it also gets `/v1`, matching the container's `/v1/audio/*` surface.
 *
 * Sub-paths are then appended WITHOUT a leading `/v1` (e.g. `/audio/speech`).
 */
function openaiApiBase(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
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
    res = await fetch(`${openaiApiBase(target.baseURL)}/audio/transcriptions`, {
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

  return fetch(`${openaiApiBase(target.baseURL)}/audio/speech`, {
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

/**
 * Best-effort reachability probe of a speech endpoint (GET /v1/models).
 *
 * Only ever called against the advertised same-origin `/voice` pass-through
 * (VoiceClientSettings), where a redirect means the app-level landing guard
 * bounced the request — i.e. the endpoint is NOT here — so `redirect:'manual'`
 * refuses to follow it (following it would land on an HTML 200 and report a
 * dead endpoint as available). Should this ever probe a user-configured
 * absolute-URL provider, note that a benign upstream redirect (http→https,
 * trailing-slash normalization) would also read as unreachable here.
 */
export async function probeVoiceEndpoint(baseURL: string): Promise<boolean> {
  try {
    const res = await fetch(`${openaiApiBase(baseURL)}/models`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    // Reachable = the server answered for itself: 2xx, or a 4xx (endpoint
    // exists, just auth/not-found). A 3xx redirect, a 5xx, or a manual-mode
    // opaqueredirect (status 0) all mean "not this endpoint".
    return res.ok || (res.status >= 400 && res.status < 500);
  } catch {
    return false;
  }
}
