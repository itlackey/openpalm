/**
 * Client-owned voice settings — which TTS/STT provider THIS browser uses.
 *
 * These are per-client UI preferences (like the theme or the auto-speak
 * toggle), NOT host configuration: two devices attached to the same host can
 * legitimately differ (a desktop Chrome may use the Web Speech API while an
 * iPhone points at the host's voice container). They therefore persist in
 * browser storage, never in the host's stack.env — the host side of voice
 * (container on/off, hardware profile) lives under Capabilities → Add-ons.
 *
 * Providers:
 *   - 'browser'            → Web Speech API (SpeechRecognition / speechSynthesis)
 *   - 'openpalm-voice'     → the host's voice container, discovered via the
 *                            /api/runtime handshake's `voice.url` advertisement
 *   - 'openai-compatible'  → any OpenAI-shaped /v1/audio endpoint the user
 *                            configures (baseURL/model/…, optional API key)
 *   - 'disabled'           → no speech on this side
 *
 * API keys never live in this record — only a `secretRef` pointer into the
 * encrypted browser secret store (the same store that holds connection
 * passwords).
 */

export type VoiceProviderId = 'disabled' | 'browser' | 'openpalm-voice' | 'openai-compatible';

export type VoiceSttSettings = {
  provider: VoiceProviderId;
  baseURL?: string;
  model?: string;
  /** BCP-47 language hint, forwarded to whichever engine is active. */
  language?: string;
  /** Secret-store ref for the provider API key (openai-compatible only). */
  secretRef?: string;
};

export type VoiceTtsSettings = {
  provider: VoiceProviderId;
  baseURL?: string;
  model?: string;
  voice?: string;
  secretRef?: string;
};

export type VoiceClientSettings = {
  version: 1;
  stt: VoiceSttSettings;
  tts: VoiceTtsSettings;
};

const STORAGE_KEY = 'openpalm.voice.settings';

const PROVIDER_IDS: readonly VoiceProviderId[] = [
  'disabled',
  'browser',
  'openpalm-voice',
  'openai-compatible',
];

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readSection<T extends VoiceSttSettings | VoiceTtsSettings>(raw: unknown): T | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!PROVIDER_IDS.includes(r.provider as VoiceProviderId)) return null;
  const section: Record<string, unknown> = { provider: r.provider };
  for (const key of ['baseURL', 'model', 'language', 'voice', 'secretRef']) {
    if (typeof r[key] === 'string' && r[key]) section[key] = r[key];
  }
  return section as T;
}

/** Read + validate the persisted settings. Null = never saved / unreadable
 * (callers fall back to capability-based defaults). */
export function loadVoiceSettings(): VoiceClientSettings | null {
  const raw = safeLocalStorage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stt = readSection<VoiceSttSettings>(parsed.stt);
    const tts = readSection<VoiceTtsSettings>(parsed.tts);
    if (!stt || !tts) return null;
    return { version: 1, stt, tts };
  } catch {
    return null;
  }
}

export function saveVoiceSettings(settings: VoiceClientSettings): void {
  try {
    safeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/blocked — the in-memory session keeps working.
  }
}
