/**
 * GET /admin/voice  — Return current TTS/STT env vars from stack.env plus
 *                     an `availability` block (best-effort reachability of
 *                     the configured remote endpoints).
 * PUT /admin/voice  — Write TTS/STT env vars to stack.env. Auto-enables
 *                     the openpalm-voice addon, brings the chosen profile
 *                     up, waits for /health, and translates Docker errors
 *                     to operator-actionable copy.
 */
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  annotateAddonProfileAvailability,
  buildComposeOptions,
  composeStop,
  composeUp,
  getAddonProfiles,
  getAddonProfileAvailability,
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
// compose.yml advertises start_period: 180s. The probe must wait at least
// that long on a cold-disk first launch (model download + warm-up).
const VOICE_PROBE_TIMEOUT_MS = 180_000;
const VOICE_PROBE_INTERVAL_MS = 1_000;

const REACHABILITY_TIMEOUT_MS = 1_500;
const PORT_PROBE_TIMEOUT_MS = 750;

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

/**
 * Prefer the labelled default, but skip it if it's known-unavailable on
 * the host. Falls back to the first available profile, then the first
 * profile, then null.
 */
function resolveDefaultProfile(profiles: AddonProfile[]): string | null {
  if (profiles.length === 0) return null;
  const labelledDefault = profiles.find((p) => p.default);
  if (labelledDefault && labelledDefault.available !== false) {
    return labelledDefault.id;
  }
  const firstAvailable = profiles.find((p) => p.available !== false);
  if (firstAvailable) return firstAvailable.id;
  return profiles[0].id;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const env = readStackEnv(state.stackDir);

  const ttsBaseURL = env['OP_TTS_BASE_URL'] ?? '';
  const sttBaseURL = env['OP_STT_BASE_URL'] ?? '';

  const rawProfiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
  const profiles = await annotateAddonProfileAvailability(rawProfiles);
  const selectedProfile =
    getAddonProfileSelection(state.stackDir, VOICE_ADDON) ?? resolveDefaultProfile(profiles);

  const [sttReachable, ttsReachable] = await Promise.all([
    probeReachable(sttBaseURL),
    probeReachable(ttsBaseURL),
  ]);

  return jsonResponse(200, {
    tts: {
      enabled: true,
      engine: env['OP_TTS_ENGINE'] ?? '',
      provider: env['OP_TTS_PROVIDER'] ?? '',
      baseURL: ttsBaseURL,
      model: env['OP_TTS_MODEL'] ?? '',
      voice: env['OP_TTS_VOICE'] ?? '',
    },
    stt: {
      enabled: true,
      engine: env['OP_STT_ENGINE'] ?? '',
      provider: env['OP_STT_PROVIDER'] ?? '',
      baseURL: sttBaseURL,
      model: env['OP_STT_MODEL'] ?? '',
      language: env['OP_STT_LANGUAGE'] ?? '',
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
function voiceHostPort(): number {
  const raw = process.env.OP_VOICE_PORT_HOST?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8880;
}

function openpalmVoiceBaseURL(): string {
  return `http://127.0.0.1:${voiceHostPort()}`;
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

// ── Docker error translation ─────────────────────────────────────────

/**
 * Translate raw docker / compose stderr into operator-actionable copy.
 *
 * Exported for tests. Pattern matches are intentionally case-insensitive
 * and tolerant of compose-CLI prefix decoration. Order matters: the more
 * specific patterns are tried first.
 */
export function translateDockerError(stderr: string | undefined | null): string {
  const raw = (stderr ?? '').trim();
  if (!raw) return 'Docker reported an unknown error (no stderr).';

  // Pull failures: image missing or auth denied.
  if (/pull access denied|manifest unknown|repository does not exist|not found: manifest unknown/i.test(raw)) {
    return "The voice image for this profile isn't published yet. Try the CPU profile.";
  }

  // Port collisions.
  if (/port is already allocated|bind.*address already in use|address already in use/i.test(raw)) {
    return 'Port 8880 is already in use on this host. Free it or change the host port.';
  }

  // NVIDIA runtime missing (legacy --runtime path).
  if (/unknown[^\n]*runtime[^\n]*nvidia|runtime\s+"nvidia"\s+not\s+found|nvidia.*runtime.*not[^a-z]+(found|registered)/i.test(raw)) {
    return "The NVIDIA Docker runtime isn't registered on this machine. Try the CPU profile, or install nvidia-container-toolkit.";
  }

  // CDI-mode daemon with no spec generated.
  if (/invoking the NVIDIA Container Runtime Hook/i.test(raw)) {
    return 'Docker is in CDI mode but no CDI spec is registered. Try the CPU profile.';
  }

  // Default: include the first ~300 chars verbatim so the operator at
  // least has something searchable.
  const slice = raw.length > 300 ? raw.slice(0, 297) + '…' : raw;
  return slice;
}

// ── Helpers: docker image inspect, port probe, container probe ─────

function execFileNoThrow(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
  });
}

/**
 * True when the local docker daemon already has the named image cached.
 * `docker image inspect` exits 0 only when the image is present locally.
 */
async function dockerImagePresent(imageRef: string): Promise<boolean> {
  if (!imageRef) return true;
  const res = await execFileNoThrow('docker', ['image', 'inspect', imageRef], 5_000);
  return res.ok;
}

/**
 * Heuristic: image tags that include `-cu121` / `-rocm6` / `-cpu` are the
 * multi-GB voice images. Show the "this may take a few minutes" toast for
 * first pulls so the operator knows the upcoming compose-up isn't stuck.
 */
function isLargeImageTag(imageRef: string): boolean {
  return /(-cu\d+|-rocm\d+|-cpu)(\s|$|@|\b)/i.test(imageRef);
}

/**
 * Read the resolved image for a service from the merged compose config.
 * Best-effort — returns "" on any failure so callers can skip the pre-pull
 * check rather than blocking save.
 */
async function resolveServiceImage(
  composeFiles: string[],
  service: string,
): Promise<string> {
  const args = ['compose'];
  for (const f of composeFiles) args.push('-f', f);
  args.push('--project-name', resolveProjectName(), 'config', '--format', 'json');
  const res = await execFileNoThrow('docker', args, 15_000);
  if (!res.ok) return '';
  try {
    const parsed = JSON.parse(res.stdout) as { services?: Record<string, { image?: string }> };
    return parsed.services?.[service]?.image ?? '';
  } catch {
    return '';
  }
}

function resolveProjectName(): string {
  return (
    process.env.OP_PROJECT_NAME?.trim() ||
    process.env.COMPOSE_PROJECT_NAME?.trim() ||
    'openpalm'
  );
}

/**
 * Probe a TCP port on 127.0.0.1. Resolves true when the connect succeeds
 * within PORT_PROBE_TIMEOUT_MS — meaning something is already listening.
 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (listening: boolean): void => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve(listening);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * True when a docker container whose name matches openpalm-voice* is
 * already running and presumably owns the host port. Used by the port
 * pre-flight to avoid false positives when our own voice container is
 * the listener.
 */
async function ourVoiceContainerRunning(): Promise<boolean> {
  const res = await execFileNoThrow(
    'docker',
    ['ps', '--filter', 'name=openpalm-voice', '--format', '{{.Names}}'],
    5_000,
  );
  if (!res.ok) return false;
  return res.stdout.trim().length > 0;
}

/**
 * Read the Docker healthcheck state of a container.
 * Returns "starting" while compose's start_period grace window is in
 * effect; "healthy" / "unhealthy" / "none" / "" otherwise.
 */
async function readContainerHealthStatus(containerNamePrefix: string): Promise<string> {
  const listRes = await execFileNoThrow(
    'docker',
    ['ps', '--filter', `name=${containerNamePrefix}`, '--format', '{{.Names}}'],
    5_000,
  );
  const name = listRes.stdout.split('\n').map((s) => s.trim()).find(Boolean);
  if (!name) return '';
  const inspect = await execFileNoThrow(
    'docker',
    ['inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'],
    5_000,
  );
  return inspect.stdout.trim();
}

// ── CDI fallback overlay ─────────────────────────────────────────────

/**
 * Write a sibling compose overlay that switches `voice-cuda` from the
 * legacy `runtime: nvidia` form to the CDI `driver: cdi` form. Caller
 * includes it in the composeUp file list ONLY when the host probe
 * indicates the runtime is missing but a CDI spec exists.
 *
 * The canonical compose.yml stays as the runtime-nvidia form (the case
 * that needs no manual setup beyond installing nvidia-container-toolkit).
 *
 * Returns the absolute path of the overlay, or null when there is no
 * enabled voice addon directory to write into.
 */
function writeCdiOverlayIfNeeded(homeDir: string): string | null {
  const addonDir = join(homeDir, 'config', 'stack', 'addons', VOICE_ADDON);
  if (!existsSync(addonDir)) return null;
  const overlayPath = join(addonDir, 'compose.cdi.yml');
  const yaml = [
    '# Generated overlay — switches voice-cuda from runtime:nvidia to CDI.',
    '# Applied only when the host probe shows the legacy NVIDIA runtime is',
    '# missing but /etc/cdi/nvidia.yaml is present.',
    'services:',
    '  voice-cuda:',
    '    runtime: ""',
    '    deploy:',
    '      resources:',
    '        reservations:',
    '          devices:',
    '            - driver: cdi',
    '              device_ids:',
    '                - nvidia.com/gpu=all',
    '',
  ].join('\n');
  writeFileSync(overlayPath, yaml);
  return overlayPath;
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

  // ── Auto-stop when neither side uses openpalm-voice ──────────────
  // We don't disable the addon (operator may toggle back quickly), but
  // we free the port + RAM by stopping the container. composeStop is a
  // no-op when nothing is running.
  if (!wantsVoiceAddon) {
    const enabledIds = listEnabledAddonIds(state.homeDir);
    if (enabledIds.includes(VOICE_ADDON)) {
      try {
        const voiceServiceNames = getAddonProfiles(state.homeDir, VOICE_ADDON).flatMap((p) => p.services);
        const unique = Array.from(new Set(voiceServiceNames));
        if (unique.length > 0) {
          await composeStop(unique, buildComposeOptions(state));
        }
      } catch (e) {
        // Best-effort. The user moved away from openpalm-voice; we don't
        // want to block the save on a stop failure.
        console.warn('[voice] composeStop on disengage failed:', e);
      }
    }
    return jsonResponse(200, { ok: true }, requestId);
  }

  // Resolve which compose profile (cpu/cuda/rocm/…) to bring up. Body
  // wins; falls back to whatever is already in stack.env; if neither is
  // set, picks the profile marked openpalm.profile.default in the
  // addon compose.yml (else the first one). Unknown profile ids are
  // rejected against the addon's declared profile catalog.
  const rawProfiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
  const availableProfiles = await annotateAddonProfileAvailability(rawProfiles);
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

  // ── Pre-flight port collision check ──────────────────────────────
  // Save the operator from the half-recreate Docker leaves behind when
  // it tries to bind a host port that's already taken. We skip when our
  // own voice container is the listener (we'll replace it cleanly via
  // --force-recreate below). The vitest harness sets VITEST=1; under
  // tests this whole check is meaningless because the integration
  // surface is mocked, so we short-circuit.
  const hostPort = voiceHostPort();
  const inVitest = !!process.env.VITEST;
  const portTaken = inVitest ? false : await isPortListening(hostPort);
  if (portTaken) {
    const oursIsRunning = await ourVoiceContainerRunning();
    if (!oursIsRunning) {
      const msg = translateDockerError(`Bind for 127.0.0.1:${hostPort} failed: port is already allocated`);
      steps.push({ step: 'port-check', ok: false, detail: msg });
      return jsonResponse(
        502,
        {
          ok: false,
          voiceAddon: {
            wasAlreadyEnabled,
            steps,
            error: msg,
          },
        },
        requestId,
      );
    }
    steps.push({ step: 'port-check', ok: true, detail: 'our container is the listener' });
  } else {
    steps.push({ step: 'port-check', ok: true });
  }

  // ── Pre-flight image inspect ─────────────────────────────────────
  // If the image is missing locally AND its tag is a known large one,
  // emit a `pulling` step so the toast can show "first-time download
  // — several minutes for several GB" instead of just spinning.
  const profileServices = activeProfile
    ? (availableProfiles.find((p) => p.id === activeProfile)?.services ?? [])
    : [];
  const services = profileServices.length > 0 ? profileServices : [VOICE_ADDON];

  const composeFilesBase = buildComposeOptions(state).files;
  const primaryService = services[0];
  if (primaryService && !inVitest) {
    const imageRef = await resolveServiceImage(composeFilesBase, primaryService);
    if (imageRef && isLargeImageTag(imageRef)) {
      const present = await dockerImagePresent(imageRef);
      if (!present) {
        steps.push({
          step: 'pulling',
          ok: true,
          detail: 'first-time download — several minutes for several GB',
        });
      }
    }
  }

  // ── CDI fallback for cuda profile ───────────────────────────────
  // When the operator picks `cuda` but the host has only CDI (no
  // legacy nvidia runtime), generate a sibling overlay that rewrites
  // voice-cuda to use deploy.resources.reservations.devices+driver:cdi.
  // The canonical compose stays the runtime-nvidia form (no manual
  // setup case). Overlay is applied only for this one composeUp.
  const extraFiles: string[] = [];
  if (activeProfile === 'cuda' && !inVitest) {
    const cudaAvailability = await getAddonProfileAvailability({ id: 'cuda' });
    const runtimeMissing = cudaAvailability.available === false
      || !await dockerHasNvidiaRuntime();
    const cdiSpecPresent = existsSync('/etc/cdi/nvidia.yaml');
    if (runtimeMissing && cdiSpecPresent) {
      const overlay = writeCdiOverlayIfNeeded(state.homeDir);
      if (overlay) {
        extraFiles.push(overlay);
        steps.push({ step: 'cdi-fallback', ok: true, detail: 'using CDI device reservation' });
      }
    }
  }

  // composeUp the voice service. compose pulls the image (no-op if
  // already present), creates the container, starts it. We wait for
  // the /health endpoint to return 200 so the operator gets a real
  // "ready" signal instead of a "kicked off" one.
  let composeOk = true;
  let composeErr: string | undefined;
  try {
    // Profile switch: stop services that belong to OTHER profiles so they
    // release their host port binding (all variants share 8880) before we
    // bring up the chosen one. Use composeStop, not down, to keep their
    // images cached for a future switch back.
    const otherProfileServices = availableProfiles
      .filter((p) => p.id !== activeProfile)
      .flatMap((p) => p.services)
      .filter((svc) => !services.includes(svc));
    if (otherProfileServices.length > 0) {
      try {
        await composeStop(otherProfileServices, buildComposeOptions(state));
      } catch (e) {
        // Best-effort — stopping a never-created service is harmless.
        // The subsequent up will still fail loudly if there's a real
        // port collision, so we just log and continue.
        console.warn('[voice] composeStop other profiles failed:', e);
      }
    }

    const baseOpts = buildComposeOptions(state);
    const result = await composeUp({
      ...baseOpts,
      files: [...baseOpts.files, ...extraFiles],
      services,
      forceRecreate: true,
      ...(activeProfile ? { profiles: [activeProfile] } : {}),
    });
    composeOk = result.ok;
    if (!result.ok) {
      // Surface per-service failure detail (image pull error, etc.) the
      // same way /admin/update does, then translate to operator copy.
      const failures = parseComposeStderr(result.stderr);
      const voiceFailure = failures.find((f) => services.includes(f.service));
      const rawDetail = voiceFailure?.reason ?? result.stderr ?? `compose up exited ${result.code}`;
      composeErr = translateDockerError(rawDetail);
    }
  } catch (e) {
    composeOk = false;
    composeErr = translateDockerError(e instanceof Error ? e.message : String(e));
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

  // If the probe ran out the clock, ask Docker whether the container's
  // healthcheck is still in `starting` state. If so, treat it as success
  // with `warming: true` so the UI can show "still warming up" rather
  // than a hard error — the start_period grace window can be > 180s on
  // a cold disk.
  let warming = false;
  if (!healthy) {
    try {
      const health = await readContainerHealthStatus('openpalm-voice');
      if (health === 'starting') warming = true;
    } catch {
      // ignore — fall through to the unhealthy response
    }
  }

  steps.push({
    step: 'healthy',
    ok: healthy || warming,
    ...(healthy
      ? {}
      : warming
        ? { detail: 'still warming up — refresh in a moment' }
        : { detail: `did not respond at ${probeUrl} within ${VOICE_PROBE_TIMEOUT_MS / 1000}s` }),
  });

  return jsonResponse(
    healthy || warming ? 200 : 502,
    {
      ok: healthy || warming,
      voiceAddon: {
        wasAlreadyEnabled,
        steps,
        ...(warming ? { warming: true } : {}),
        ...(healthy || warming ? {} : { error: 'Voice addon is starting but did not become healthy in time.' }),
      },
    },
    requestId,
  );
};

/**
 * Lightweight wrapper around `docker info` to check whether the
 * `nvidia` runtime is registered. Used as a second signal alongside the
 * cached `getAddonProfileAvailability('cuda')` result.
 */
async function dockerHasNvidiaRuntime(): Promise<boolean> {
  const res = await execFileNoThrow(
    'docker',
    ['info', '--format', '{{json .Runtimes}}'],
    2_000,
  );
  return res.ok && res.stdout.includes('"nvidia"');
}
