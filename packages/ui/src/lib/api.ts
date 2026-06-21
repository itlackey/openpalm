import type {
  HealthPayload,
  ChatEntry,
  ChatMessage,
  ChatToolGroup,
  ContainerListResponse,
  AutomationsResponse,
  SessionSummary,
} from './types.js';
import { toolStripEntryFromSessionPart, type SessionMessagePart } from '$lib/chat/tool-strip.js';

const apiBase = '';

export function buildHeaders(): HeadersInit {
  return {
    'x-request-id': crypto.randomUUID(),
    'x-requested-by': 'ui'
  };
}

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: HeadersInit = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...buildHeaders()
  };
  return fetch(`${apiBase}${path}`, {
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

async function readErrorMessage(
  res: Response,
  fallback = `Request failed (HTTP ${res.status})`
): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await res.clone().json().catch((e: unknown) => {
      console.warn('[api] Failed to parse JSON error response:', e);
      return null;
    })) as Record<string, unknown> | null;
    if (data && typeof data.message === 'string' && data.message.length > 0) return data.message;
    if (data && typeof data.error === 'string' && data.error.length > 0) return data.error;
  }
  const text = await res.text().catch((e: unknown) => {
    console.warn('[api] Failed to read error response text:', e);
    return '';
  });
  return text || fallback;
}

/** Throw on 401; throw readErrorMessage on non-OK. Returns the response. */
async function requireOk(res: Response, fallback?: string): Promise<Response> {
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(await readErrorMessage(res, fallback)), { status: res.status });
  }
  return res;
}

// ── Health ──────────────────────────────────────────────────────────────

export async function fetchHealth(): Promise<{
  admin: HealthPayload | null;
  guardian: HealthPayload | null;
}> {
  const [adminRes, guardianRes] = await Promise.all([
    request('GET', '/health'),
    request('GET', '/guardian/health').catch((e: unknown) => {
      console.warn('[api] Guardian health check failed:', e);
      return null;
    })
  ]);
  const admin = (await adminRes.json()) as HealthPayload;
  let guardian: HealthPayload | null = null;
  if (guardianRes) {
    try {
      guardian = (await guardianRes.json()) as HealthPayload;
    } catch (e) {
      console.warn('[api] Failed to parse guardian health response:', e);
      guardian = { status: 'unavailable', service: 'guardian' };
    }
  }
  return { admin, guardian };
}

// ── Containers ──────────────────────────────────────────────────────────

export async function fetchContainers(): Promise<ContainerListResponse> {
  const res = await requireOk(await request('GET', '/admin/containers/list'));
  return (await res.json()) as ContainerListResponse;
}

export async function containerAction(
  action: 'start' | 'stop' | 'restart',
  containerId: string
): Promise<void> {
  const pathMap = {
    start: '/admin/containers/up',
    stop: '/admin/containers/down',
    restart: '/admin/containers/restart'
  } as const;
  await requireOk(await request('POST', pathMap[action], { service: containerId }));
}

// ── Lifecycle ───────────────────────────────────────────────────────────

export type ApplyChangesResult = {
  ok: boolean;
  restarted: string[];
  failed: { service: string; reason: string }[];
  dockerAvailable: boolean;
  overallSuccess: boolean;
  error?: string;
};

export async function applyChanges(): Promise<ApplyChangesResult> {
  // The route returns 502 when individual services fail (e.g. an addon
  // image isn't available). The body still carries the structured result,
  // so parse it before requireOk would throw.
  const res = await request('POST', '/admin/update', {});
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // Non-JSON error (e.g. 500 HTML). Fall back to the generic helper.
    throw new Error(await readErrorMessage(res, `Apply failed (HTTP ${res.status})`));
  }
  const data = (await res.json()) as ApplyChangesResult;
  return data;
}

export type UpgradeStackResult = {
  ok: boolean;
  imageTag: string;
  backupDir: string | null;
  assetsUpdated: string[];
  restarted: string[];
  adminRecreateScheduled: boolean;
};

export async function upgradeStack(): Promise<UpgradeStackResult> {
  const res = await requireOk(await request('POST', '/admin/upgrade', {}));
  return (await res.json()) as UpgradeStackResult;
}

// ── Version management ───────────────────────────────────────────────────

/** One configured stack piece + the image tag it actually runs (#503). The
 *  Updates tab flags any whose version is behind its own latest published tag.
 *  `latestVersion` is the best-effort latest tag for THIS unit's image on Docker
 *  Hub (null when the check failed or was skipped). */
export interface VersionsResponse {
  versions: Record<string, string>;
  platformVersion: string;
  autoUpdate: boolean;
}

export async function fetchVersions(): Promise<VersionsResponse> {
  const res = await requireOk(await request('GET', '/admin/versions'));
  return (await res.json()) as VersionsResponse;
}

/** Persist version pins to stack.env. Only keys in the server's ALL_VERSION_KEYS
 *  allowlist are accepted; the change takes effect on the next POST /admin/update. */
export async function patchVersions(versions: Record<string, string>): Promise<{ ok: boolean; versions: Record<string, string> }> {
  const res = await requireOk(await request('PATCH', '/admin/versions', { versions }));
  return (await res.json()) as { ok: boolean; versions: Record<string, string> };
}


/** Response from GET /admin/versions/latest — resolved latest versions from
 *  GitHub releases (images) and npm registry (packages). null means the registry
 *  was unreachable for that key. */
export interface LatestVersionsResponse {
  versions: Record<string, string | null>;
  errors: string[];
  fetchedAt: string;
}

/** Query the latest available versions from GitHub releases + npm registry.
 *  Called only on explicit user action; never auto-polled. */
export async function fetchLatestVersions(): Promise<LatestVersionsResponse> {
  const res = await requireOk(await request('GET', '/admin/versions/latest'));
  return (await res.json()) as LatestVersionsResponse;
}

/** Preview the release migrations an upgrade to <tag> would run (#497). Returns
 *  the human-readable `[dry-run]` log lines from ensureReleaseMigrated. */
export async function previewMigration(
  tag: string,
): Promise<{ ok: boolean; targetVersion: string; applied: string[]; lines: string[]; notes: string[] }> {
  const res = await requireOk(await request('POST', '/admin/migrate-preview', { tag }));
  return (await res.json()) as { ok: boolean; targetVersion: string; applied: string[]; lines: string[]; notes: string[] };
}

// ── Backups (#499) ──────────────────────────────────────────────────────

export interface BackupEntryView {
  path: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupSummaryView {
  ok: boolean;
  count: number;
  totalBytes: number;
  lastBackupAt: string | null;
  backups: BackupEntryView[];
}

export async function fetchBackups(): Promise<BackupSummaryView> {
  const res = await requireOk(await request('GET', '/admin/backups'));
  return (await res.json()) as BackupSummaryView;
}

/** Drives the confirm-gated prune — keeps the newest `keep`, deletes older. */
export async function pruneBackups(keep: number): Promise<{ ok: boolean; deleted: string[]; kept: number }> {
  const res = await requireOk(await request('POST', '/admin/backups', { keep }));
  return (await res.json()) as { ok: boolean; deleted: string[]; kept: number };
}

// ── Secret-strip notice (#502) ──────────────────────────────────────────

export async function fetchSecretStripNotice(): Promise<{ ok: boolean; notice: { keys: string[]; at: string } | null }> {
  const res = await requireOk(await request('GET', '/admin/secret-notice'));
  return (await res.json()) as { ok: boolean; notice: { keys: string[]; at: string } | null };
}

export async function dismissSecretStripNotice(): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('DELETE', '/admin/secret-notice'));
  return (await res.json()) as { ok: boolean };
}

// ── Install lock / stuck-operation recovery (#500) ──────────────────────

export interface InstallLockStatusView {
  ok: boolean;
  present: boolean;
  stale: boolean;
  pid: number | null;
  timestamp: number | null;
  ageMs: number | null;
  path: string;
  staleAfterMs: number;
}

export async function fetchInstallLockStatus(): Promise<InstallLockStatusView> {
  const res = await requireOk(await request('GET', '/admin/unlock'));
  return (await res.json()) as InstallLockStatusView;
}

/**
 * Clears a STALE install lock. Throws the server's plain-language message when
 * a live install is still holding it (HTTP 409) — never forces.
 */
export async function clearInstallLock(): Promise<{ ok: boolean; removed: boolean }> {
  const res = await requireOk(await request('POST', '/admin/unlock'));
  return (await res.json()) as { ok: boolean; removed: boolean };
}

export async function downloadUiVersion(
  tag: string,
): Promise<{ ok: boolean; tag: string; restarting: boolean; pendingRestart: boolean }> {
  const res = await requireOk(await request('POST', '/admin/ui-version', { tag }));
  return (await res.json()) as { ok: boolean; tag: string; restarting: boolean; pendingRestart: boolean };
}

// ── Automations ─────────────────────────────────────────────────────────

export async function fetchAutomations(): Promise<AutomationsResponse> {
  const res = await requireOk(await request('GET', '/admin/automations'));
  return (await res.json()) as AutomationsResponse;
}

export async function runAutomation(name: string): Promise<{ ok: boolean; name: string; status: string; error: string | null }> {
  const res = await requireOk(await request('POST', `/admin/automations/${encodeURIComponent(name)}/run`));
  return (await res.json()) as { ok: boolean; name: string; status: string; error: string | null };
}

export async function fetchAutomationLog(name: string, limit = 200): Promise<{ name: string; lines: string[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await requireOk(
    await request('GET', `/admin/automations/${encodeURIComponent(name)}/log?${params.toString()}`)
  );
  return (await res.json()) as { name: string; lines: string[] };
}

// ── Service Logs ────────────────────────────────────────────────

export async function fetchServiceLogs(
  options?: { service?: string; tail?: number; since?: string }
): Promise<{ ok: boolean; logs: string; error?: string }> {
  const params = new URLSearchParams();
  if (options?.service) params.set('service', options.service);
  if (options?.tail) params.set('tail', String(options.tail));
  if (options?.since) params.set('since', options.since);
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/logs${qs ? `?${qs}` : ''}`));
  return (await res.json()) as { ok: boolean; logs: string; error?: string };
}


// ── Addon Management ────────────────────────────────────────────────────

export async function fetchAddons(): Promise<{ name: string; enabled: boolean; available: boolean }[]> {
  const res = await requireOk(await request('GET', '/admin/addons'));
  const data = (await res.json()) as { addons: { name: string; enabled: boolean; available: boolean }[] };
  return data.addons;
}

export async function toggleAddon(
  name: string,
  enabled: boolean,
  env?: Record<string, string>
): Promise<{ ok: boolean; changed: boolean }> {
  const body: Record<string, unknown> = { enabled };
  if (env) body.env = env;
  const res = await requireOk(await request('POST', `/admin/addons/${encodeURIComponent(name)}`, body));
  return (await res.json()) as { ok: boolean; changed: boolean };
}

export type AddonCredentialField = {
  key: string;
  sensitive: boolean;
  description: string;
  default: string;
  set: boolean;
  value: string;
};

export async function fetchAddonCredentials(name: string): Promise<AddonCredentialField[]> {
  const res = await requireOk(await request('GET', `/admin/addons/${encodeURIComponent(name)}/credentials`));
  const data = (await res.json()) as { fields: AddonCredentialField[] };
  return data.fields;
}

export async function saveAddonCredentials(
  name: string,
  values: Record<string, string>
): Promise<{ ok: boolean; updated: string[] }> {
  const res = await requireOk(
    await request('POST', `/admin/addons/${encodeURIComponent(name)}/credentials`, { values })
  );
  return (await res.json()) as { ok: boolean; updated: string[] };
}

// ── User env (akm env:user) ────────────────────────────────────────

export type UserEnvListResponse = {
  provider: 'akm';
  envRef: string;
  keys: string[];
};

export async function fetchUserEnv(): Promise<UserEnvListResponse> {
  const res = await requireOk(await request('GET', '/admin/secrets/user-env'));
  return (await res.json()) as UserEnvListResponse;
}

export async function writeUserEnvKey(key: string, value: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets/user-env', { key, value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteUserEnvKey(key: string): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('DELETE', `/admin/secrets/user-env?key=${encodeURIComponent(key)}`)
  );
  return (await res.json()) as { ok: boolean };
}

// ── Secret files (/stash/secrets file browser) ──────────────────────────────
export type SecretFileInfo = { name: string; size: number };

export async function fetchSecretFiles(): Promise<{ files: SecretFileInfo[] }> {
  const res = await requireOk(await request('GET', '/admin/secrets'));
  return (await res.json()) as { files: SecretFileInfo[] };
}

export async function fetchSecretFile(name: string): Promise<{ name: string; value: string }> {
  const res = await requireOk(await request('GET', `/admin/secrets/${encodeURIComponent(name)}`));
  return (await res.json()) as { name: string; value: string };
}

export async function saveSecretFile(name: string, value: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PUT', `/admin/secrets/${encodeURIComponent(name)}`, { value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteSecretFile(name: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('DELETE', `/admin/secrets/${encodeURIComponent(name)}`));
  return (await res.json()) as { ok: boolean };
}

// ── Automation task files (/stash/tasks editor) ─────────────────────────────
export async function fetchTaskFile(name: string): Promise<{ name: string; content: string }> {
  const res = await requireOk(await request('GET', `/admin/automations/${encodeURIComponent(name)}/file`));
  return (await res.json()) as { name: string; content: string };
}

export async function saveTaskFile(name: string, content: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PUT', `/admin/automations/${encodeURIComponent(name)}/file`, { content }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteTaskFile(name: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('DELETE', `/admin/automations/${encodeURIComponent(name)}/file`));
  return (await res.json()) as { ok: boolean };
}

// ── Voice Config ────────────────────────────────────────────────────────

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
  const res = await requireOk(await request('GET', '/admin/voice'));
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
  const res = await request('PUT', '/admin/voice', config);
  // 401 still throws so the auth gate can re-arm.
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid password.'), { status: 401 });
  }
  // 200 (saved + voice ready), 202 (saved, voice still pulling/starting
  // in background — caller polls /admin/voice for activeJob), and 502
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

// ── AKM Config ──────────────────────────────────────────────────────

export async function fetchAkmConfig(): Promise<{ config: Record<string, unknown> }> {
  const res = await requireOk(await request('GET', '/admin/akm'));
  return (await res.json()) as { config: Record<string, unknown> };
}

export async function saveAkmConfig(settings: Record<string, unknown>): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PATCH', '/admin/akm', settings));
  return (await res.json()) as { ok: boolean };
}

export type AkmEmbeddingDetection = {
  ok: true;
  endpoint: string;
  model: string;
  provider: string;
  dimension: number;
  message: string;
};

export type AkmEmbeddingTestResult = {
  ok: true;
  dimension: number;
  message: string;
  provider?: string;
};

export async function detectAkmEmbedding(): Promise<AkmEmbeddingDetection> {
  const res = await requireOk(await request('POST', '/admin/akm/embedding/detect', {}));
  return (await res.json()) as AkmEmbeddingDetection;
}

export async function testAkmEmbedding(settings: {
  endpoint: string;
  model: string;
  provider?: string;
  apiKey?: string;
  dimension?: number;
}): Promise<AkmEmbeddingTestResult> {
  const res = await requireOk(await request('POST', '/admin/akm/embedding/test', settings));
  return (await res.json()) as AkmEmbeddingTestResult;
}

export async function reindexAkm(): Promise<{ ok: boolean; message: string; output?: string }> {
  const res = await requireOk(await request('POST', '/admin/akm/reindex', {}));
  return (await res.json()) as { ok: boolean; message: string; output?: string };
}

export type AssistantSettings = {
  projectName: string;
  lanExposureEnabled: boolean;
  stackEnvPath: string;
  personaPath: string;
  personaContent: string;
};

export async function fetchAssistantSettings(): Promise<AssistantSettings> {
  const res = await requireOk(await request('GET', '/admin/assistant'));
  return (await res.json()) as AssistantSettings;
}

export async function saveAssistantSettings(input: {
  projectName: string;
  lanExposureEnabled: boolean;
  personaContent: string;
}): Promise<{ ok: boolean; projectName: string; lanExposureEnabled: boolean; stackEnvPath: string; personaPath: string; personaContent: string }> {
  const res = await requireOk(await request('PUT', '/admin/assistant', input));
  return (await res.json()) as { ok: boolean; projectName: string; lanExposureEnabled: boolean; stackEnvPath: string; personaPath: string; personaContent: string };
}

// ── AKM Health (dashboard metrics) ──────────────────────────────────
export type AkmHealth =
  | { available: false; reason?: string }
  | {
      available: true;
      status: 'ok' | 'warn' | 'fail' | 'unknown';
      ok: boolean | null;
      checks: { pass: number; warn: number; fail: number };
      metrics: Record<string, number> | null;
      index: {
        entryCount?: number;
        lastBuiltAt?: string;
        hasEmbeddings?: boolean;
        vecAvailable?: boolean;
      } | null;
    };

export async function fetchAkmHealth(): Promise<AkmHealth> {
  const res = await requireOk(await request('GET', '/admin/akm/health'));
  return (await res.json()) as AkmHealth;
}

export type AkmKnowledgeStats =
  | { available: false; reason?: string }
  | {
      available: true;
      version: string | null;
      health: {
        status: 'pass' | 'warn' | 'unknown';
        advisories: string[];
      };
      index: {
        entryCount: number | null;
        lastBuiltAt: string | null;
        hasEmbeddings: boolean | null;
        vecAvailable: boolean | null;
      };
      assetCounts: {
        memory: number | null;
        skill: number | null;
        lesson: number | null;
      };
      improve: {
        invoked: number | null;
        completed: number | null;
        skipped: number | null;
        reflectOk: number | null;
        reflectCooldown: number | null;
        consolidation: {
          promoted: number | null;
          merged: number | null;
          deleted: number | null;
        };
      };
      proposals: {
        pending: number;
        items: Array<{
          ref: string | null;
          generator: string | null;
          createdAt: string | null;
          status: string | null;
        }>;
      };
    };

export async function fetchAkmKnowledgeStats(): Promise<AkmKnowledgeStats> {
  const res = await requireOk(await request('GET', '/admin/akm/stats'));
  return (await res.json()) as AkmKnowledgeStats;
}

// ── Host AKM sharing ────────────────────────────────────────────────
export type HostAkmSharing = {
  sharing: { available: boolean; enabled: boolean; hostStashPath: string | null };
  profilesImported?: string[];
};

export async function fetchHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('GET', '/admin/akm/host-sharing'));
  return (await res.json()) as HostAkmSharing;
}

export async function enableHostAkmSharing(
  opts: { writable?: boolean; importProfiles?: boolean } = {}
): Promise<HostAkmSharing> {
  const res = await requireOk(await request('PUT', '/admin/akm/host-sharing', opts));
  return (await res.json()) as HostAkmSharing;
}

export async function disableHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('DELETE', '/admin/akm/host-sharing'));
  return (await res.json()) as HostAkmSharing;
}

// ── Docker Pull ─────────────────────────────────────────────────────

export async function pullImages(): Promise<void> {
  await requireOk(await request('POST', '/admin/containers/pull', {}));
}

// ── Assistant Endpoints ─────────────────────────────────────────────

export type AssistantEndpoint = {
  id: string;
  label: string;
  url: string;
  isDefault: boolean;
  hasPassword: boolean;
};

export type EndpointListResponse = {
  endpoints: AssistantEndpoint[];
  activeId: string;
};

export async function fetchEndpoints(): Promise<EndpointListResponse> {
  const res = await requireOk(await request('GET', '/admin/endpoints'));
  return (await res.json()) as EndpointListResponse;
}

export async function createEndpoint(input: {
  label: string;
  url: string;
  password?: string;
}): Promise<{ endpoint: AssistantEndpoint }> {
  const res = await requireOk(await request('POST', '/admin/endpoints', input));
  return (await res.json()) as { endpoint: AssistantEndpoint };
}

export async function updateEndpoint(
  id: string,
  patch: { label?: string; url?: string; password?: string | null }
): Promise<{ endpoint: AssistantEndpoint }> {
  const res = await requireOk(
    await request('PATCH', `/admin/endpoints/${encodeURIComponent(id)}`, patch)
  );
  return (await res.json()) as { endpoint: AssistantEndpoint };
}

export async function deleteEndpoint(id: string): Promise<void> {
  await requireOk(await request('DELETE', `/admin/endpoints/${encodeURIComponent(id)}`));
}

export async function setActiveEndpoint(id: string): Promise<{ activeId: string; endpoint: AssistantEndpoint }> {
  const res = await requireOk(await request('POST', '/admin/endpoints/active', { id }));
  return (await res.json()) as { activeId: string; endpoint: AssistantEndpoint };
}

// ── Chat Proxy ──────────────────────────────────────────────────────────

/**
 * Create a new OpenCode session via the SvelteKit broker.
 *
 * Only `/proxy/assistant/*` is reachable from the browser. The active
 * OpenCode instance is selected server-side via the connection switcher.
 */
export async function createSession(): Promise<{ id: string }> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/session`, {})
  );
  return (await res.json()) as { id: string };
}

/**
 * List sessions on the active OpenCode endpoint.
 *
 * OpenCode returns `Array<Session>` with no ordering guarantee; we sort
 * desc by `time.updated` here so consumers can rely on it. See
 * docs/technical/multi-endpoint-session-ux.md §2.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  const res = await requireOk(await request('GET', '/proxy/assistant/session'));
  const raw = (await res.json()) as Array<{
    id: string;
    title?: string;
    time?: { created?: number; updated?: number };
  }>;
  const summaries: SessionSummary[] = raw.map((s) => ({
    id: s.id,
    title: s.title ?? '',
    createdAt: s.time?.created ?? 0,
    updatedAt: s.time?.updated ?? s.time?.created ?? 0,
  }));
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Fetch the messages for a session and map them to UI `ChatEntry`s.
 *
 * Tool parts are grouped into the assistant turn that follows them (attached
 * as `toolStates` on the `ChatMessage`). If tool parts appear with no
 * following assistant text in the same OpenCode message they are emitted as a
 * single `ChatToolGroup` entry — never as N separate entries.
 *
 * Skips non-text, non-tool parts (files, reasoning, etc.). Empty-text
 * messages with no tool activity are dropped.
 */
export async function getSessionMessages(sessionId: string): Promise<ChatEntry[]> {
  const res = await requireOk(
    await request(
      'GET',
      `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`
    )
  );
  const rows = (await res.json()) as Array<{
    info: {
      id: string;
      role: 'user' | 'assistant';
      time?: { created?: number };
    };
    parts: SessionMessagePart[];
  }>;
  const messages: ChatEntry[] = [];
  for (const row of rows) {
    const timestamp = row.info.time?.created ?? Date.now();
    let textBuffer = '';
    let textIndex = 0;
    const pendingToolStates: import('./types.js').ToolStripEntry[] = [];

    const flushText = (): void => {
      const text = textBuffer.trim();
      textBuffer = '';
      if (!text && pendingToolStates.length === 0) return;

      if (text) {
        const entry: ChatMessage = {
          id: textIndex === 0 ? row.info.id : `${row.info.id}:text:${textIndex}`,
          role: row.info.role,
          text,
          timestamp,
        };
        if (pendingToolStates.length > 0) {
          entry.toolStates = [...pendingToolStates];
          pendingToolStates.length = 0;
        }
        messages.push(entry);
        textIndex += 1;
      } else if (pendingToolStates.length > 0) {
        // Tools with no following text in this message — emit as orphan group.
        const group: ChatToolGroup = {
          id: `${row.info.id}:tools:${textIndex}`,
          type: 'tool-group',
          toolStates: [...pendingToolStates],
          timestamp,
        };
        pendingToolStates.length = 0;
        messages.push(group);
        textIndex += 1;
      }
    };

    row.parts.forEach((part, index) => {
      if (part.type === 'text' && part.text) {
        textBuffer += part.text;
        return;
      }
      if (part.type === 'tool' || part.state) {
        const toolState = toolStripEntryFromSessionPart(part, `${row.info.id}:${index}`);
        if (!toolState) return;
        pendingToolStates.push(toolState);
      }
    });

    flushText();
  }
  return messages;
}

/**
 * Send a message to an existing OpenCode session via the SvelteKit broker.
 * Uses direct fetch with a 150s AbortSignal timeout — OpenCode responses
 * can take 30–120s.
 */
export async function sendChatMessage(
  sessionId: string,
  text: string
): Promise<import('./types.js').OpenCodeMessageResponse> {
  const res = await fetch(
    `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildHeaders(),
      },
      credentials: 'include',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(150_000),
    }
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()) as import('./types.js').OpenCodeMessageResponse;
}

export async function startChatMessageTurn(
  sessionId: string,
  text: string
): Promise<void> {
  const res = await fetch(
    `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildHeaders(),
      },
      credentials: 'include',
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
      }),
      signal: AbortSignal.timeout(150_000),
    }
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }
}

export async function replyChatPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject'
): Promise<void> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/permission/${encodeURIComponent(requestId)}/reply`, { reply })
  );
  await res.text().catch(() => '');
}

export async function replyChatQuestion(requestId: string, answers: string[][]): Promise<void> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/question/${encodeURIComponent(requestId)}/reply`, { answers })
  );
  await res.text().catch(() => '');
}

export async function rejectChatQuestion(requestId: string): Promise<void> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/question/${encodeURIComponent(requestId)}/reject`, {})
  );
  await res.text().catch(() => '');
}

/**
 * Probe whether the assistant broker is reachable.
 * Returns true if the probe succeeds within 3s.
 */
export async function probeChatBackend(): Promise<boolean> {
  try {
    const res = await fetch(`/proxy/assistant/provider`, {
      method: 'GET',
      headers: buildHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
