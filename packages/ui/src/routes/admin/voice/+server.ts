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
  addonProfileId,
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
import { translateDockerError } from '$lib/server/voice-errors.js';
import { withSerialQueue } from '$lib/server/serial-queue.js';

const VOICE_ADDON = 'voice';
// compose.yml advertises start_period: 180s. The probe must wait at least
// that long on a cold-disk first launch (model download + warm-up).
const VOICE_PROBE_TIMEOUT_MS = 180_000;
const VOICE_PROBE_INTERVAL_MS = 1_000;

// ── Background-pull job state ────────────────────────────────────────
// First-time image pulls can take many minutes on slow connections.
// Browser fetch timeouts (90–120s typical) and the route's 180s health
// poll both fire long before a 2–8 GB pull finishes — operators end up
// staring at a "network error" while the pull is still running. To
// decouple, when we detect an absent large-tag image we kick off the
// long work (composeUp + health poll) in the background, return 202
// immediately, and have the UI poll GET /admin/voice for status.
type VoiceJobState = 'pulling' | 'starting' | 'healthy' | 'error';
type VoiceJobStep = { step: string; ok: boolean; detail?: string };
export type VoiceActiveJob = {
  state: VoiceJobState;
  steps: VoiceJobStep[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
  profile?: string;
};
const JOB_RETAIN_MS = 5 * 60_000;
const activeJobs = new Map<string, VoiceActiveJob>();

function setJob(addon: string, patch: Partial<VoiceActiveJob>): VoiceActiveJob {
  const existing = activeJobs.get(addon);
  const next: VoiceActiveJob = existing
    ? { ...existing, ...patch }
    : {
        state: 'pulling',
        steps: [],
        startedAt: Date.now(),
        ...patch,
      };
  activeJobs.set(addon, next);
  return next;
}

function getActiveJob(addon: string): VoiceActiveJob | undefined {
  const job = activeJobs.get(addon);
  if (!job) return undefined;
  const age = Date.now() - (job.finishedAt ?? job.startedAt);
  if (age > JOB_RETAIN_MS) {
    activeJobs.delete(addon);
    return undefined;
  }
  return job;
}

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
 * Pick the best profile for this host. Prefers the first available GPU
 * profile (anything that isn't the canonical CPU profile) so operators with NVIDIA/AMD hardware
 * get the accelerated variant auto-selected. Falls back to the labelled
 * default, then first available, then first profile.
 */
function resolveDefaultProfile(profiles: AddonProfile[]): string | null {
  if (profiles.length === 0) return null;
  const availableGpu = profiles.find((p) => p.id !== addonProfileId(VOICE_ADDON, 'cpu') && p.available !== false);
  if (availableGpu) return availableGpu.id;
  const labelledDefault = profiles.find((p) => p.default);
  if (labelledDefault && labelledDefault.available !== false) return labelledDefault.id;
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

// ── Helpers: docker image inspect, port probe, container probe ─────

function execFileNoThrow(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      // ENOENT (binary missing) lands here with no stderr because the
      // child never executed. Synthesise stderr that matches the
      // translateDockerError ENOENT regex so the operator sees the
      // "Docker isn't installed" copy rather than "unknown error".
      let mergedStderr = stderr?.toString() ?? '';
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code && !mergedStderr) {
        if (code === 'ENOENT') {
          mergedStderr = `spawn ${cmd} ENOENT: command not found`;
        } else {
          mergedStderr = `spawn ${cmd} ${code}`;
        }
      }
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? '',
        stderr: mergedStderr,
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
  // No addon directory → nothing to overlay onto. Returning null keeps
  // composeUp's file list valid (no stray reference to a non-existent file).
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

// ── Rootless Docker fallback ─────────────────────────────────────────

/**
 * Detect rootless Docker. The compose `user: "${OP_UID:-1000}:${OP_GID:-1000}"`
 * directive bakes the host UID into the container — but on a rootless
 * daemon the bind-mount UID inside the container is subuid-remapped, so
 * the resulting container UID has no write permission against
 * `${OP_HOME}/data/voice/models`. Removing the `user:` directive lets
 * Docker pick whatever UID the rootless mapping translates to inside the
 * user namespace, which DOES have write access to the bind-mount.
 *
 * `docker info` is the authoritative source: rootless daemons advertise
 * `SecurityOptions: ... name=rootless` and `CgroupDriver: ... rootless`.
 * We accept either signal.
 */
async function detectRootlessDocker(): Promise<boolean> {
  const res = await execFileNoThrow(
    'docker',
    ['info', '--format', '{{json .}}'],
    5_000,
  );
  if (!res.ok || !res.stdout) return false;
  try {
    const parsed = JSON.parse(res.stdout) as {
      SecurityOptions?: unknown;
      CgroupDriver?: unknown;
    };
    const sec = Array.isArray(parsed.SecurityOptions)
      ? parsed.SecurityOptions.map((s) => String(s))
      : [];
    if (sec.some((s) => /name=rootless/i.test(s))) return true;
    if (typeof parsed.CgroupDriver === 'string' && /rootless/i.test(parsed.CgroupDriver)) {
      return true;
    }
    return false;
  } catch {
    // Fall back to a stringy contains-check if the JSON shape changes.
    return /name=rootless|cgroup\s*driver:.*rootless/i.test(res.stdout);
  }
}

/**
 * Write a sibling overlay that drops the `user:` directive from each
 * voice service. Mirrors writeCdiOverlayIfNeeded: caller includes the
 * returned path in composeUp's file list. Returns null when there is
 * no enabled voice addon directory to write into (so the file list
 * stays valid and Docker doesn't blow up on a missing -f arg).
 */
function writeRootlessOverlayIfNeeded(homeDir: string): string | null {
  const addonDir = join(homeDir, 'config', 'stack', 'addons', VOICE_ADDON);
  if (!existsSync(addonDir)) return null;
  const overlayPath = join(addonDir, 'compose.rootless.yml');
  // `user: null` in YAML drops the directive when compose merges files.
  // We cover all three voice service variants so the overlay works no
  // matter which profile is active.
  const yaml = [
    '# Generated overlay — removes the `user:` directive from voice services.',
    '# Applied only when `docker info` reports a rootless daemon. On rootless',
    '# Docker the compose-baked UID has no write access to the bind-mounted',
    '# state directory; letting Docker pick the namespaced UID restores it.',
    'services:',
    '  voice:',
    '    user: null',
    '  voice-cuda:',
    '    user: null',
    '  voice-rocm:',
    '    user: null',
    '',
  ].join('\n');
  writeFileSync(overlayPath, yaml);
  return overlayPath;
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

  // Resolve which canonical compose profile to bring up. Body
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
      setAddonEnabled(state.homeDir, state.stackDir, VOICE_ADDON, true, state);
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
  // we'll fork the long work (composeUp + healthcheck) into a
  // background job so the UI can return immediately and poll
  // GET /admin/voice for progress.
  const profileServices = activeProfile
    ? (availableProfiles.find((p) => p.id === activeProfile)?.services ?? [])
    : [];
  const services = profileServices.length > 0 ? profileServices : [VOICE_ADDON];

  const composeFilesBase = buildComposeOptions(state).files;
  const primaryService = services[0];
  let backgroundPull = false;
  if (primaryService && !inVitest) {
    const imageRef = await resolveServiceImage(composeFilesBase, primaryService);
    if (imageRef && isLargeImageTag(imageRef)) {
      const present = await dockerImagePresent(imageRef);
      if (!present) {
        backgroundPull = true;
        steps.push({
          step: 'pulling',
          ok: true,
          detail: 'first-time download — several minutes for several GB',
        });
      }
    }
  }

  // ── CDI fallback for canonical CUDA profile ─────────────────────
  // When the operator picks `cuda` but the host has only CDI (no
  // legacy nvidia runtime), generate a sibling overlay that rewrites
  // voice-cuda to use deploy.resources.reservations.devices+driver:cdi.
  // The canonical compose stays the runtime-nvidia form (no manual
  // setup case). Overlay is applied only for this one composeUp.
  //
  // Skipped on Windows: the operator must use Docker Desktop with WSL2
  // GPU integration there, and CDI specs live inside WSL2 — the Node
  // host can't read /etc/cdi/* and the probe would always fail.
  const extraFiles: string[] = [];
  const cdiFallbackSupported = process.platform !== 'win32';
  if (activeProfile === addonProfileId(VOICE_ADDON, 'cuda') && !inVitest && cdiFallbackSupported) {
    const cudaAvailability = await getAddonProfileAvailability({ id: addonProfileId(VOICE_ADDON, 'cuda') });
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

  // ── Rootless Docker fallback ─────────────────────────────────────
  // On rootless Docker the compose-baked `user: ${OP_UID}:${OP_GID}`
  // directive resolves to a UID that the namespaced container can't use
  // to write the bind-mounted models directory. Drop the directive via
  // a sibling overlay; Docker then picks the in-namespace UID, which
  // has the right permission against the subuid-remapped bind mount.
  if (!inVitest) {
    try {
      const rootless = await detectRootlessDocker();
      if (rootless) {
        const overlay = writeRootlessOverlayIfNeeded(state.homeDir);
        if (overlay) {
          extraFiles.push(overlay);
          steps.push({
            step: 'rootless-fallback',
            ok: true,
            detail: 'dropping user: directive for rootless Docker',
          });
        }
      }
    } catch (e) {
      // Detection failures fall through to the un-overlayed path. The
      // operator can still complete the save; if they hit a permission
      // error inside the container, the existing translateDockerError
      // copy points them at the underlying cause.
      console.warn('[voice] rootless detection failed:', e);
    }
  }

  // ── Background-pull short-circuit ────────────────────────────────
  // When the image is missing AND large, fork the rest of the work
  // (composeStop, composeUp, /health poll) into a job that updates the
  // module-level activeJobs map. Return 202 immediately so the
  // browser/SvelteKit fetch doesn't time out during the multi-minute
  // pull. UI polls GET /admin/voice for the activeJob status.
  if (backgroundPull) {
    setJob(VOICE_ADDON, {
      state: 'pulling',
      steps: [...steps],
      startedAt: Date.now(),
      profile: activeProfile ?? undefined,
      finishedAt: undefined,
      error: undefined,
    });
    // Fire-and-forget. The job runner writes its own terminal state into
    // activeJobs; we never await it.
    void runBringUpJob({
      state,
      services,
      activeProfile,
      extraFiles,
      availableProfiles,
      baseSteps: [...steps],
    });
    return jsonResponse(
      202,
      {
        ok: true,
        voiceAddon: {
          wasAlreadyEnabled,
          status: 'pulling',
          steps,
          message:
            'Voice image is downloading in the background (~2–8 GB). ' +
            'Poll GET /admin/voice for progress; UI auto-refreshes.',
        },
      },
      requestId,
    );
  }

  // ── Synchronous path ─────────────────────────────────────────────
  // The image is already present (or we couldn't tell). Run the
  // compose-up + health poll inline so the caller gets the terminal
  // state in one round trip.
  const outcome = await runBringUp({
    state,
    services,
    activeProfile,
    extraFiles,
    availableProfiles,
    steps,
  });

  if (!outcome.composeOk) {
    return jsonResponse(
      502,
      {
        ok: false,
        voiceAddon: {
          wasAlreadyEnabled,
          steps: outcome.steps,
          error: `Voice addon failed to start: ${outcome.composeErr ?? 'unknown error'}`,
        },
      },
      requestId,
    );
  }

  return jsonResponse(
    outcome.healthy || outcome.warming ? 200 : 502,
    {
      ok: outcome.healthy || outcome.warming,
      voiceAddon: {
        wasAlreadyEnabled,
        steps: outcome.steps,
        ...(outcome.warming ? { warming: true } : {}),
        ...(outcome.healthy || outcome.warming
          ? {}
          : { error: 'Voice addon is starting but did not become healthy in time.' }),
      },
    },
    requestId,
  );
}

type BringUpInput = {
  state: ReturnType<typeof getState>;
  services: string[];
  activeProfile: string | null;
  extraFiles: string[];
  availableProfiles: AddonProfile[];
  steps: VoiceJobStep[];
};

type BringUpOutcome = {
  composeOk: boolean;
  composeErr?: string;
  healthy: boolean;
  warming: boolean;
  steps: VoiceJobStep[];
};

/**
 * Inline composeStop-other-profiles + composeUp + /health poll. Returns
 * the terminal state. Pushed `steps` get mutated in place so the caller
 * (sync or background) can read progress as it happens.
 */
async function runBringUp(input: BringUpInput): Promise<BringUpOutcome> {
  const { state, services, activeProfile, extraFiles, availableProfiles, steps } = input;

  let composeOk = true;
  let composeErr: string | undefined;
  try {
    // Profile switch: stop services from OTHER profiles so they release
    // their host port binding (all variants share 8880) before we bring
    // up the chosen one. composeStop, not down, keeps their images
    // cached for a future switch back.
    const otherProfileServices = availableProfiles
      .filter((p) => p.id !== activeProfile)
      .flatMap((p) => p.services)
      .filter((svc) => !services.includes(svc));
    if (otherProfileServices.length > 0) {
      try {
        await composeStop(otherProfileServices, buildComposeOptions(state));
      } catch (e) {
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
    return { composeOk, composeErr, healthy: false, warming: false, steps };
  }

  // Poll /health until ready (or timeout).
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

  let warming = false;
  if (!healthy) {
    try {
      const health = await readContainerHealthStatus('openpalm-voice');
      if (health === 'starting') warming = true;
    } catch {
      /* ignore */
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

  return { composeOk, healthy, warming, steps };
}

type BringUpJobInput = Omit<BringUpInput, 'steps'> & { baseSteps: VoiceJobStep[] };

/**
 * Background variant: runs runBringUp and persists state transitions
 * into the activeJobs map. Returns nothing — the UI polls GET
 * /admin/voice to observe completion.
 */
async function runBringUpJob(input: BringUpJobInput): Promise<void> {
  const steps = [...input.baseSteps];
  try {
    setJob(VOICE_ADDON, { state: 'starting', steps });
    const outcome = await runBringUp({ ...input, steps });
    if (!outcome.composeOk) {
      setJob(VOICE_ADDON, {
        state: 'error',
        steps: outcome.steps,
        error: `Voice addon failed to start: ${outcome.composeErr ?? 'unknown error'}`,
        finishedAt: Date.now(),
      });
      return;
    }
    setJob(VOICE_ADDON, {
      state: outcome.healthy ? 'healthy' : outcome.warming ? 'starting' : 'error',
      steps: outcome.steps,
      ...(outcome.healthy || outcome.warming
        ? { error: undefined }
        : { error: 'Voice addon is starting but did not become healthy in time.' }),
      finishedAt: Date.now(),
    });
  } catch (e) {
    setJob(VOICE_ADDON, {
      state: 'error',
      steps,
      error: e instanceof Error ? e.message : String(e),
      finishedAt: Date.now(),
    });
  }
}

/**
 * Lightweight wrapper around `docker info` to check whether the
 * `nvidia` runtime is registered. Used as a second signal alongside the
 * cached canonical CUDA profile availability result.
 */
async function dockerHasNvidiaRuntime(): Promise<boolean> {
  const res = await execFileNoThrow(
    'docker',
    ['info', '--format', '{{json .Runtimes}}'],
    2_000,
  );
  return res.ok && res.stdout.includes('"nvidia"');
}
