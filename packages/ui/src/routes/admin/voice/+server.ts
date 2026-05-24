/**
 * GET /admin/voice  — Return current TTS/STT env vars from stack.env plus
 *                     an `availability` block (best-effort reachability of
 *                     the configured remote endpoints).
 * PUT /admin/voice  — Write TTS/STT env vars to stack.env. Rejects engines
 *                     with required fields missing and rejects the
 *                     `openpalm-voice` engine entirely (not shipped yet).
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { readStackEnv, writeVoiceVars } from '@openpalm/lib';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
} from '$lib/server/helpers.js';

const REACHABILITY_TIMEOUT_MS = 1_500;

async function probeReachable(baseURL: string): Promise<boolean> {
  if (!baseURL) return false;
  const url = baseURL.replace(/\/+$/, '') + '/v1/models';
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
    // Any non-network-error response counts: even 401 means the endpoint
    // exists and is listening. 405 (HEAD unsupported) is fine too.
    return res.status < 500;
  } catch {
    return false;
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const env = readStackEnv(state.stackDir);

  const ttsBaseURL = env['TTS_BASE_URL'] ?? '';
  const sttBaseURL = env['STT_BASE_URL'] ?? '';

  const [sttReachable, ttsReachable] = await Promise.all([
    probeReachable(sttBaseURL),
    probeReachable(ttsBaseURL),
  ]);

  return jsonResponse(200, {
    tts: {
      enabled: true,
      engine: env['TTS_ENGINE'] ?? '',
      provider: env['TTS_PROVIDER'] ?? '',
      baseURL: ttsBaseURL,
      model: env['TTS_MODEL'] ?? '',
      voice: env['TTS_VOICE'] ?? '',
    },
    stt: {
      enabled: true,
      engine: env['STT_ENGINE'] ?? '',
      provider: env['STT_PROVIDER'] ?? '',
      baseURL: sttBaseURL,
      model: env['STT_MODEL'] ?? '',
      language: env['STT_LANGUAGE'] ?? '',
    },
    availability: {
      stt: {
        remoteConfigured: Boolean(sttBaseURL),
        remoteReachable: sttReachable,
      },
      tts: {
        remoteConfigured: Boolean(ttsBaseURL),
        remoteReachable: ttsReachable,
      },
    },
  }, requestId);
};

type VoiceSection = {
  enabled: boolean;
  engine?: string;
  provider?: string;
  baseURL?: string;
  model?: string;
  voice?: string;
  language?: string;
};

function readSection(raw: Record<string, unknown> | undefined, kind: 'tts' | 'stt'): VoiceSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const section: VoiceSection = {
    enabled: raw.enabled !== false,
    engine: typeof raw.engine === 'string' ? raw.engine : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
  };
  if (kind === 'tts' && typeof raw.voice === 'string') section.voice = raw.voice;
  if (kind === 'stt' && typeof raw.language === 'string') section.language = raw.language;
  return section;
}

// Preset values for the bundled openpalm/voice addon. The voice container
// exposes both endpoints on a single host:port and the UI server reaches
// it through the loopback binding in the voice addon's compose overlay.
// Host port is overridable via OP_VOICE_PORT_HOST in stack.env (defaults
// to 8880, matching the container's internal port).
function openpalmVoiceBaseURL(): string {
  const port = process.env.OP_VOICE_PORT_HOST?.trim() || '8880';
  return `http://127.0.0.1:${port}`;
}

const OPENPALM_VOICE_TTS_MODEL = 'kokoro';
const OPENPALM_VOICE_STT_MODEL = 'whisper-1';
const OPENPALM_VOICE_DEFAULT_VOICE = 'bf_isabella';

/**
 * For `engine === 'openpalm-voice'`, fill in baseURL/model with the addon's
 * preset values when the user didn't provide them. This is the auto-config
 * that makes "select OpenPalm Voice → Save" Just Work as long as the addon
 * is enabled. The user can still override (e.g. point at a different
 * voice host on the LAN).
 */
function applyOpenPalmVoicePreset(section: VoiceSection, kind: 'tts' | 'stt'): void {
  if (section.engine !== 'openpalm-voice') return;
  if (!section.baseURL || !section.baseURL.trim()) section.baseURL = openpalmVoiceBaseURL();
  if (!section.model || !section.model.trim()) {
    section.model = kind === 'tts' ? OPENPALM_VOICE_TTS_MODEL : OPENPALM_VOICE_STT_MODEL;
  }
  if (kind === 'tts' && (!section.voice || !section.voice.trim())) {
    section.voice = OPENPALM_VOICE_DEFAULT_VOICE;
  }
}

function validateSection(section: VoiceSection | null, kind: 'tts' | 'stt'): string | null {
  if (!section || !section.engine) return null;
  // `browser` engines store no server-side URL — fine.
  if (section.engine === 'browser' || section.engine === 'browser-stt' || section.engine === 'browser-tts') {
    return null;
  }
  if (section.engine.startsWith('skip-')) return null;
  // openpalm-voice gets its baseURL/model auto-filled from the preset
  // before validation runs, so it always satisfies the remote check.
  // Any remote (including openpalm-voice with a user-supplied URL) must
  // end up with a non-empty baseURL.
  if (!section.baseURL || !section.baseURL.trim()) {
    return `Remote ${kind.toUpperCase()} requires an endpoint URL.`;
  }
  return null;
}

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    return errorResponse(400, 'Bad Request', 'Invalid JSON body', {}, requestId);
  }
  if (!body || typeof body !== 'object') {
    return errorResponse(400, 'Bad Request', 'Body must be an object', {}, requestId);
  }

  const b = body as Record<string, unknown>;
  const ttsSection = readSection(b.tts as Record<string, unknown> | undefined, 'tts');
  const sttSection = readSection(b.stt as Record<string, unknown> | undefined, 'stt');

  // Apply the openpalm-voice preset BEFORE validation — selecting the
  // engine alone (no URL/model in the form) is enough; the preset fills
  // the gaps so the remote-baseURL check passes.
  if (ttsSection) applyOpenPalmVoicePreset(ttsSection, 'tts');
  if (sttSection) applyOpenPalmVoicePreset(sttSection, 'stt');

  const ttsErr = validateSection(ttsSection, 'tts');
  if (ttsErr) return errorResponse(400, 'invalid_tts', ttsErr, {}, requestId);

  const sttErr = validateSection(sttSection, 'stt');
  if (sttErr) return errorResponse(400, 'invalid_stt', sttErr, {}, requestId);

  const config: Parameters<typeof writeVoiceVars>[0] = {};
  if (ttsSection) {
    config.tts = {
      enabled: ttsSection.enabled,
      engine: ttsSection.engine,
      provider: ttsSection.provider,
      baseURL: ttsSection.baseURL,
      model: ttsSection.model,
      voice: ttsSection.voice,
    };
  }
  if (sttSection) {
    config.stt = {
      enabled: sttSection.enabled,
      engine: sttSection.engine,
      provider: sttSection.provider,
      baseURL: sttSection.baseURL,
      model: sttSection.model,
      language: sttSection.language,
    };
  }

  writeVoiceVars(config, state.stackDir);

  return jsonResponse(200, { ok: true }, requestId);
};
