import { request, requireOk, readErrorMessage, buildHeaders } from './core.js';

// ── Voice Config ──────────────────────────────────────────────────────────────

export type VoiceAddonProfile = {
  id: string;
  services: string[];
  label?: string;
  requires?: string;
  default?: boolean;
  /** Set by the server when the host can actually run this profile (e.g. NVIDIA drivers detected). */
  available?: boolean;
  /** Human-readable explanation surfaced as a tooltip when `available` is false. */
  reason?: string;
};
export type VoiceActiveJob = {
  state: 'pulling' | 'starting' | 'healthy' | 'error';
  steps: VoiceAddonStep[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
  profile?: string;
};
export type VoiceAddonInfo = {
  profiles: VoiceAddonProfile[];
  selectedProfile: string | null;
  /** Present while a background pull/start is in flight or has just completed. */
  activeJob?: VoiceActiveJob;
};

export async function fetchVoiceConfig(): Promise<{
  tts: Record<string, unknown>;
  stt: Record<string, unknown>;
  addon?: VoiceAddonInfo;
}> {
  const res = await requireOk(await request('GET', '/api/host/voice'));
  return (await res.json()) as {
    tts: Record<string, unknown>;
    stt: Record<string, unknown>;
    addon?: VoiceAddonInfo;
  };
}

export type VoiceAddonStep = { step: string; ok: boolean; detail?: string };
export type VoiceAddonStatus = 'pulling' | 'starting' | 'healthy' | 'error';
export type SaveVoiceResult = {
  ok: boolean;
  /** HTTP status the server returned (200 / 202 / 502). */
  status: number;
  voiceAddon?: {
    wasAlreadyEnabled: boolean;
    steps: VoiceAddonStep[];
    /** Present on 202 background-pull responses. */
    status?: VoiceAddonStatus;
    message?: string;
    error?: string;
  };
};

export async function saveVoiceConfig(config: { tts?: unknown; stt?: unknown; profile?: string }): Promise<SaveVoiceResult> {
  const res = await request('PUT', '/api/host/voice', config);
  // 401 still throws so the auth gate can re-arm.
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid password.'), { status: 401 });
  }
  // 200 (saved + voice ready), 202 (saved, voice still pulling/starting
  // in background — caller polls /api/host/voice for activeJob), and 502
  // (saved, voice failed) all carry a structured `voiceAddon` payload.
  if (res.status === 200 || res.status === 202 || res.status === 502) {
    const body = (await res.json()) as Omit<SaveVoiceResult, 'status'>;
    return { ...body, status: res.status };
  }
  // Other failure modes (400 invalid_tts / invalid_stt etc.) → throw
  // with a message the form can render.
  throw new Error(await readErrorMessage(res));
}

/**
 * POST a recorded audio Blob to /api/transcribe.
 *
 * Goes through the SvelteKit server-side proxy (cookie-auth) which
 * forwards to the configured STT_BASE_URL. Returns the transcript text.
 */
export async function transcribeAudio(
  blob: Blob,
  opts?: { language?: string; prompt?: string }
): Promise<string> {
  const form = new FormData();
  form.append('audio', blob, 'recording.webm');
  if (opts?.language) form.append('language', opts.language);
  if (opts?.prompt) form.append('prompt', opts.prompt);

  const res = await requireOk(
    await fetch('/api/transcribe', {
      method: 'POST',
      headers: buildHeaders(),
      credentials: 'include',
      body: form,
    })
  );
  const data = (await res.json()) as { text?: string };
  return typeof data.text === 'string' ? data.text : '';
}
