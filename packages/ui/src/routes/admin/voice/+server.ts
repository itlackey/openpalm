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
import {
  buildComposeOptions,
  composeUp,
  getAddonProfiles,
  getAddonProfileSelection,
  listEnabledAddonIds,
  parseComposeStderr,
  readStackEnv,
  setAddonEnabled,
  setAddonProfileSelection,
  writeVoiceVars,
} from '@openpalm/lib';
import type { AddonProfile } from '@openpalm/lib';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
} from '$lib/server/helpers.js';

const VOICE_ADDON = 'voice';
const VOICE_PROBE_TIMEOUT_MS = 30_000;
const VOICE_PROBE_INTERVAL_MS = 1_000;

const REACHABILITY_TIMEOUT_MS = 1_500;

async function probeReachable(baseURL: string): Promise<boolean> {
  if (!baseURL) return false;
  const url = baseURL.replace(/\/+$/, '') + '/v1/models';
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

function resolveDefaultProfile(profiles: AddonProfile[]): string | null {
  if (profiles.length === 0) return null;
  return (profiles.find((p) => p.default) ?? profiles[0]).id;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const env = readStackEnv(state.stackDir);

  const ttsBaseURL = env['TTS_BASE_URL'] ?? '';
  const sttBaseURL = env['STT_BASE_URL'] ?? '';

  const profiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
  const selectedProfile =
    getAddonProfileSelection(state.stackDir, VOICE_ADDON) ?? resolveDefaultProfile(profiles);

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
    addon: {
      profiles,
      selectedProfile,
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

  // If either side targets OpenPalm Voice, make sure the addon is
  // enabled + running before we tell the operator "saved". This is the
  // one extra step that makes "select the engine → save" actually
  // produce a working setup, instead of saving the config and leaving
  // the user to discover the addon needs to be enabled separately.
  const wantsVoiceAddon =
    ttsSection?.engine === 'openpalm-voice' || sttSection?.engine === 'openpalm-voice';

  if (!wantsVoiceAddon) {
    return jsonResponse(200, { ok: true }, requestId);
  }

  // Resolve which compose profile (cpu/cuda/rocm/…) to bring up. Body
  // wins; falls back to whatever is already in stack.env; if neither is
  // set, picks the profile marked openpalm.profile.default in the
  // addon compose.yml (else the first one). Unknown profile ids are
  // rejected against the addon's declared profile catalog.
  const availableProfiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
  const requestedProfile = typeof b.profile === 'string' ? b.profile.trim() : '';
  let activeProfile: string | null = null;
  if (requestedProfile) {
    if (!availableProfiles.some((p) => p.id === requestedProfile)) {
      return errorResponse(
        400,
        'invalid_profile',
        `Unknown voice profile "${requestedProfile}". Available: ${availableProfiles.map((p) => p.id).join(', ') || '(none)'}`,
        {},
        requestId,
      );
    }
    activeProfile = requestedProfile;
    setAddonProfileSelection(state.stackDir, VOICE_ADDON, activeProfile);
  } else {
    activeProfile =
      getAddonProfileSelection(state.stackDir, VOICE_ADDON) ??
      resolveDefaultProfile(availableProfiles);
  }

  const enabledIds = listEnabledAddonIds(state.homeDir);
  const wasAlreadyEnabled = enabledIds.includes(VOICE_ADDON);

  // Track each side-effect for the operator-facing toast in VoiceTab.
  const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];

  if (!wasAlreadyEnabled) {
    try {
      setAddonEnabled(state.homeDir, state.stackDir, VOICE_ADDON, true);
      steps.push({ step: 'enable', ok: true });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ step: 'enable', ok: false, detail });
      return jsonResponse(
        502,
        {
          ok: false,
          voiceAddon: {
            wasAlreadyEnabled,
            steps,
            error: `Could not enable voice addon: ${detail}`,
          },
        },
        requestId,
      );
    }
  } else {
    steps.push({ step: 'enable', ok: true, detail: 'already enabled' });
  }

  // composeUp the voice service. compose pulls the image (no-op if
  // already present), creates the container, starts it. We wait for
  // the /health endpoint to return 200 so the operator gets a real
  // "ready" signal instead of a "kicked off" one — first-launch
  // model load is fast (~3s) because Kokoro + Whisper base.en are
  // baked into the image.
  let composeOk = true;
  let composeErr: string | undefined;
  try {
    const profileServices = activeProfile
      ? (availableProfiles.find((p) => p.id === activeProfile)?.services ?? [])
      : [];
    const services = profileServices.length > 0 ? profileServices : [VOICE_ADDON];
    const result = await composeUp({
      ...buildComposeOptions(state),
      services,
      ...(activeProfile ? { profiles: [activeProfile] } : {}),
    });
    composeOk = result.ok;
    if (!result.ok) {
      // Surface per-service failure detail (image pull error, etc.) the
      // same way /admin/update does, so the toast can show "voice: pull
      // access denied" instead of an opaque exit code.
      const failures = parseComposeStderr(result.stderr);
      const voiceFailure = failures.find((f) => services.includes(f.service));
      composeErr = voiceFailure?.reason ?? result.stderr ?? `compose up exited ${result.code}`;
    }
  } catch (e) {
    composeOk = false;
    composeErr = e instanceof Error ? e.message : String(e);
  }
  steps.push({
    step: 'compose-up',
    ok: composeOk,
    ...(composeErr ? { detail: composeErr.slice(0, 500) } : {}),
  });

  if (!composeOk) {
    return jsonResponse(
      502,
      {
        ok: false,
        voiceAddon: {
          wasAlreadyEnabled,
          steps,
          error: `Voice addon failed to start: ${composeErr ?? 'unknown error'}`,
        },
      },
      requestId,
    );
  }

  // Poll /health until ready (or timeout). Probe URL is the same host
  // port the loopback `ports:` binding exposes (default 8880).
  const probeBase = openpalmVoiceBaseURL();
  const probeUrl = `${probeBase}/health`;
  const deadline = Date.now() + VOICE_PROBE_TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* keep polling until deadline */
    }
    await new Promise((r) => setTimeout(r, VOICE_PROBE_INTERVAL_MS));
  }
  steps.push({
    step: 'healthy',
    ok: healthy,
    ...(healthy ? {} : { detail: `did not respond at ${probeUrl} within ${VOICE_PROBE_TIMEOUT_MS / 1000}s` }),
  });

  return jsonResponse(
    healthy ? 200 : 502,
    {
      ok: healthy,
      voiceAddon: {
        wasAlreadyEnabled,
        steps,
        ...(healthy ? {} : { error: 'Voice addon is starting but did not become healthy in time.' }),
      },
    },
    requestId,
  );
};
