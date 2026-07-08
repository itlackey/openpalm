/**
 * GET /api/host/voice  — Return current TTS/STT env vars from stack.env plus
 *                     an `availability` block (best-effort reachability of
 *                     the configured remote endpoints).
 * PUT /api/host/voice  — Write TTS/STT env vars to stack.env. Auto-enables
 *                     the openpalm-voice addon, brings the chosen profile
 *                     up, waits for /health, and translates Docker errors
 *                     to operator-actionable copy.
 *
 * Request validation + response shaping live here; the Docker/compose
 * bring-up engine lives in $lib/server/voice/bring-up.ts (see the
 * lib/server/endpoints.ts ↔ admin/endpoints/+server.ts split for the
 * thin-route-over-service pattern this mirrors).
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  annotateAddonProfileAvailability,
  getAddonProfiles,
  getAddonProfileSelection,
  readStackEnv,
  writeVoiceVars,
} from '@openpalm/lib';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
} from '$lib/server/helpers.js';
import { withSerialQueue } from '$lib/server/serial-queue.js';
import {
  VOICE_ADDON,
  engageVoiceAddon,
  getActiveJob,
  openpalmVoiceBaseURL,
  resolveDefaultProfile,
} from '$lib/server/voice/bring-up.js';

const REACHABILITY_TIMEOUT_MS = 1_500;

async function probeReachable(baseURL: string): Promise<boolean> {
  if (!baseURL) return false;
  const url = `${baseURL.replace(/\/+$/, '')}/v1/models`;
  try {
    // Use GET, not HEAD. FastAPI (openpalm/voice's framework) doesn't
    // auto-derive a HEAD handler from a GET route — Starlette would
    // 405 every probe and the upstream container log fills with noise.
    // The response body is tiny (a model list), so the cost vs HEAD is
    // negligible.
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
    // Any non-network-error response counts as "reachable": even 401
    // (auth required) means the endpoint exists and is listening.
    return res.status < 500;
  } catch {
    return false;
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const env = readStackEnv(state.homeDir);

  const ttsBaseURL = env.OP_TTS_BASE_URL ?? '';
  const sttBaseURL = env.OP_STT_BASE_URL ?? '';

  const rawProfiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
  const profiles = await annotateAddonProfileAvailability(rawProfiles);
  const selectedProfile =
    getAddonProfileSelection(state.homeDir, VOICE_ADDON) ?? resolveDefaultProfile(profiles);

  const [sttReachable, ttsReachable] = await Promise.all([
    probeReachable(sttBaseURL),
    probeReachable(ttsBaseURL),
  ]);

  return jsonResponse(200, {
    tts: {
      enabled: true,
      engine: env.OP_TTS_ENGINE ?? '',
      provider: env.OP_TTS_PROVIDER ?? '',
      baseURL: ttsBaseURL,
      model: env.OP_TTS_MODEL ?? '',
      voice: env.OP_TTS_VOICE ?? '',
    },
    stt: {
      enabled: true,
      engine: env.OP_STT_ENGINE ?? '',
      provider: env.OP_STT_PROVIDER ?? '',
      baseURL: sttBaseURL,
      model: env.OP_STT_MODEL ?? '',
      language: env.OP_STT_LANGUAGE ?? '',
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
    addon: {
      profiles,
      selectedProfile,
      ...(getActiveJob(VOICE_ADDON) ? { activeJob: getActiveJob(VOICE_ADDON) } : {}),
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
  if (!section.baseURL?.trim()) section.baseURL = openpalmVoiceBaseURL();
  if (!section.model?.trim()) {
    section.model = kind === 'tts' ? OPENPALM_VOICE_TTS_MODEL : OPENPALM_VOICE_STT_MODEL;
  }
  if (kind === 'tts' && !section.voice?.trim()) {
    section.voice = OPENPALM_VOICE_DEFAULT_VOICE;
  }
}

function validateSection(section: VoiceSection | null, kind: 'tts' | 'stt'): string | null {
  if (!section?.engine) return null;
  // `browser` engines store no server-side URL — fine.
  if (section.engine === 'browser' || section.engine === 'browser-stt' || section.engine === 'browser-tts') {
    return null;
  }
  if (section.engine.startsWith('skip-')) return null;
  // openpalm-voice gets its baseURL/model auto-filled from the preset
  // before validation runs, so it always satisfies the remote check.
  // Any remote (including openpalm-voice with a user-supplied URL) must
  // end up with a non-empty baseURL.
  if (!section.baseURL?.trim()) {
    return `Remote ${kind.toUpperCase()} requires an endpoint URL.`;
  }
  return null;
}

// Per-process serialization: rapid double-saves (double-click on Save,
// or two operators racing) used to race two composeUp --force-recreate
// invocations on the same project, killing each other's containers
// mid-healthcheck. The serial queue chains saves through one promise so
// the second waits for the first to finish before starting its own work.
export const PUT: RequestHandler = (event) => {
  return withSerialQueue('admin:voice:put', () => handlePut(event));
};

async function handlePut(event: Parameters<RequestHandler>[0]): Promise<Response> {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;
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

  writeVoiceVars(config, state.homeDir);

  // If either side targets OpenPalm Voice, make sure the addon is
  // enabled + running before we tell the operator "saved". This is the
  // one extra step that makes "select the engine → save" actually
  // produce a working setup, instead of saving the config and leaving
  // the user to discover the addon needs to be enabled separately.
  const wantsVoiceAddon =
    ttsSection?.engine === 'openpalm-voice' || sttSection?.engine === 'openpalm-voice';

  const requestedProfile = typeof b.profile === 'string' ? b.profile.trim() : '';

  // Delegate the entire Docker/compose bring-up lifecycle to the service.
  const result = await engageVoiceAddon({ state, wantsVoiceAddon, requestedProfile });

  switch (result.status) {
    case 'disengaged':
      return jsonResponse(200, { ok: true }, requestId);
    case 'invalid_profile':
      return errorResponse(400, 'invalid_profile', result.message, {}, requestId);
    case 'error':
      return jsonResponse(
        502,
        {
          ok: false,
          voiceAddon: {
            wasAlreadyEnabled: result.wasAlreadyEnabled,
            steps: result.steps,
            error: result.error,
          },
        },
        requestId,
      );
    case 'background':
      return jsonResponse(
        202,
        {
          ok: true,
          voiceAddon: {
            wasAlreadyEnabled: result.wasAlreadyEnabled,
            status: 'pulling',
            steps: result.steps,
            message: result.message,
          },
        },
        requestId,
      );
    case 'final':
      return jsonResponse(
        result.healthy || result.warming ? 200 : 502,
        {
          ok: result.healthy || result.warming,
          voiceAddon: {
            wasAlreadyEnabled: result.wasAlreadyEnabled,
            steps: result.steps,
            ...(result.warming ? { warming: true } : {}),
            ...(result.healthy || result.warming
              ? {}
              : { error: 'Voice addon is starting but did not become healthy in time.' }),
          },
        },
        requestId,
      );
  }
}
