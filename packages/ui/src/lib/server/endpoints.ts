/**
 * Assistant endpoints — list of OpenCode servers the UI can target, with
 * one marked active. The "default" entry is synthesized from environment
 * (OP_OPENCODE_URL / OP_ASSISTANT_URL / OP_ASSISTANT_PORT) and cannot be
 * deleted. User-added endpoints are persisted to a JSON file in the
 * config directory (it's user-owned configuration, not service state —
 * see Phase 5 / D4 in docs/technical/auth-and-proxy-refactor-plan.md).
 *
 * File: ${configDir}/endpoints.json (mode 0600)
 * Shape: { activeId: string | null, endpoints: EndpointEntry[] }
 *   - activeId === null or "default" → use the env-derived default
 *   - activeId === "<id>" → use the matching user entry (falls back to default if not found)
 *
 * Legacy path: ${dataDir}/admin/endpoints.json. Old installs are
 * migrated lazily on first read by maybeMigrateLegacyEndpointsFile().
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getState } from './state.js';
import type { RemoteStatus } from '@openpalm/lib';

export type EndpointEntry = {
  id: string;
  label: string;
  url: string;
  /**
   * Basic-auth username forwarded as Authorization header. Defaults to
   * `"openpalm"` for synthesized entries; user-added entries may override.
   * OpenCode rejects Basic auth with an empty username — the default
   * `OPENCODE_SERVER_USERNAME` on the upstream server is `"opencode"`, but
   * OpenPalm sets it to `"openpalm"` on every server it spawns/configures.
   */
  username?: string;
  /** Optional OpenCode Basic-auth password forwarded as Authorization header. */
  password?: string;
};

export type ActiveEndpoint = EndpointEntry & {
  /** True for the env-derived default entry (cannot be edited or deleted). */
  isDefault: boolean;
  /**
   * True for the Electron-spawned ephemeral local OpenCode (Phase 3).
   * Synthesized at request time from data/local-opencode.runtime.json;
   * not persisted to endpoints.json; cannot be edited or deleted.
   */
  isLocal?: boolean;
};

type EndpointsFile = {
  activeId: string | null;
  endpoints: EndpointEntry[];
};

const DEFAULT_ID = 'default';
const LOCAL_ELECTRON_ID = 'local-electron';
let wizardOpencodeUrl: string | null = null;
let remoteStatusCache: { expiresAt: number; value: RemoteStatus[] } | null = null;

export function setWizardOpencodeUrl(url: string | null): void {
  wizardOpencodeUrl = url ? normalizeBrowserFacingUrl(url) : null;
}

export function getWizardOpencodeUrl(): string | null {
  return wizardOpencodeUrl;
}

function endpointsPath(): string {
  return `${getState().configDir}/endpoints.json`;
}

/**
 * Legacy path used before Phase 5 of the auth/proxy refactor.
 * See docs/technical/auth-and-proxy-refactor-plan.md § Phase 5 / D4.
 */
function legacyEndpointsPath(): string {
  return `${getState().dataDir}/admin/endpoints.json`;
}

/**
 * One-shot lazy migration from the legacy data/ path to the new config/ path.
 *
 * Phase 5 of docs/technical/auth-and-proxy-refactor-plan.md (D6 step 3):
 *   - If the new path already exists → no-op (already migrated).
 *   - If the legacy path doesn't exist → no-op (fresh install).
 *   - Otherwise copy contents to the new path (mode 0600), then unlink legacy.
 *
 * If the migration fails partway, the legacy file is left in place so reads
 * fall back to it for the remainder of this session. Idempotent across
 * process restarts because the existence check makes it a no-op after the
 * first successful run.
 */
function maybeMigrateLegacyEndpointsFile(): void {
  const newPath = endpointsPath();
  if (existsSync(newPath)) return;
  const oldPath = legacyEndpointsPath();
  if (!existsSync(oldPath)) return;
  try {
    mkdirSync(dirname(newPath), { recursive: true });
    const contents = readFileSync(oldPath);
    writeFileSync(newPath, contents, { mode: 0o600 });
    // Re-chmod in case the file already existed with looser perms.
    try { chmodSync(newPath, 0o600); } catch { /* best effort */ }
    unlinkSync(oldPath);
  } catch (e) {
    console.warn('[endpoints] Failed to migrate legacy endpoints.json from data/ to config/. Leaving the old file in place; reads will fall back to it for this session.', e);
  }
}

function localRuntimePath(): string {
  return `${getState().dataDir}/local-opencode.runtime.json`;
}

type LocalRuntime = {
  url: string;
  username?: string;
  password?: string;
  pid?: number;
  startedAt?: string;
};

/**
 * Read the Electron-written runtime.json each time it's needed. The file is
 * 0600 and is rewritten on each Electron launch (random password per launch),
 * so callers must NOT cache the result.
 */
function readLocalRuntime(): LocalRuntime | null {
  const path = localRuntimePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LocalRuntime>;
    if (!parsed || typeof parsed.url !== 'string' || !parsed.url) return null;
    return {
      url: parsed.url,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      password: typeof parsed.password === 'string' ? parsed.password : undefined,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
    };
  } catch (e) {
    console.warn('[endpoints] Failed to parse local-opencode.runtime.json:', e);
    return null;
  }
}

function localEndpoint(): ActiveEndpoint | null {
  const rt = readLocalRuntime();
  if (!rt) return null;
  return {
    id: LOCAL_ELECTRON_ID,
    label: 'OpenPalm Admin',
    url: normalizeBrowserFacingUrl(rt.url),
    username: rt.username || 'openpalm',
    ...(rt.password ? { password: rt.password } : {}),
    isDefault: false,
    isLocal: true,
  };
}

function normalizeBrowserFacingUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '0.0.0.0' || host === '::') {
      url.hostname = '127.0.0.1';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function readFile(): EndpointsFile {
  // Lazy one-shot migration from the legacy state/ path. Idempotent —
  // a no-op after the first successful run. See Phase 5 / D4 in
  // docs/technical/auth-and-proxy-refactor-plan.md.
  maybeMigrateLegacyEndpointsFile();

  // If the new path is present, read it. Otherwise fall back to the legacy
  // path: it only exists here if the migration failed partway (we never
  // unlinked it), and we want CRUD to keep working until the next restart
  // gives migration another chance.
  let path = endpointsPath();
  if (!existsSync(path)) {
    const legacy = legacyEndpointsPath();
    if (!existsSync(legacy)) return { activeId: null, endpoints: [] };
    path = legacy;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EndpointsFile>;
    return {
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      endpoints: Array.isArray(parsed.endpoints) ? parsed.endpoints.filter(isValidEntry) : [],
    };
  } catch (e) {
    console.warn('[endpoints] Failed to parse endpoints.json, resetting:', e);
    return { activeId: null, endpoints: [] };
  }
}

function isValidEntry(e: unknown): e is EndpointEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.label === 'string' && typeof o.url === 'string';
}

function writeFile(data: EndpointsFile): void {
  const path = endpointsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // Re-chmod in case the file already existed with looser perms
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function defaultEndpoint(): ActiveEndpoint {
  const url =
    wizardOpencodeUrl ??
    process.env.OP_OPENCODE_URL ??
    process.env.OP_ASSISTANT_URL ??
    `http://127.0.0.1:${process.env.OP_ASSISTANT_PORT ?? '3800'}`;
  const username = process.env.OPENCODE_SERVER_USERNAME || 'openpalm';
  const password = process.env.OPENCODE_SERVER_PASSWORD || undefined;
  return {
    id: DEFAULT_ID,
    label: 'Local Assistant',
    url: normalizeBrowserFacingUrl(url),
    username,
    password,
    isDefault: true,
  };
}

/**
 * Hostnames where plain HTTP is permitted. Anything else must use HTTPS.
 *
 * - `127.0.0.1`, `::1`, `localhost` — loopback addresses on the same host.
 * - `host.docker.internal` — Docker's loopback-equivalent for the container
 *   hop back to the host (used by the Electron + dev compose setups).
 *
 * Phase 6 of docs/technical/auth-and-proxy-refactor-plan.md.
 */
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
  'host.docker.internal',
]);

/**
 * `URL.hostname` wraps IPv6 addresses in square brackets (e.g. `[::1]`).
 * Strip them before checking against the loopback set so the literal IPv6
 * loopback matches `::1`.
 */
function isLoopbackHost(hostname: string): boolean {
  const stripped = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(stripped);
}

export type EndpointUrlError =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'missing_host'
  | 'http_not_allowed';

export type EndpointUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: EndpointUrlError };

/**
 * Discriminated validator that callers (admin routes) use to surface
 * specific error messages — in particular, the HTTPS-for-remote rule.
 */
export function validateEndpointUrl(input: string): EndpointUrlValidation {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_scheme' };
  }
  if (!u.hostname) {
    return { ok: false, reason: 'missing_host' };
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    return { ok: false, reason: 'http_not_allowed' };
  }
  // Strip trailing slash for consistency
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}

/**
 * Validate a URL string — must be http(s) with a host. Plain HTTP is only
 * allowed for loopback hosts (see `LOOPBACK_HOSTS`). Returns the normalized
 * URL or null. For finer-grained errors, use `validateEndpointUrl`.
 */
export function normalizeEndpointUrl(input: string): string | null {
  const result = validateEndpointUrl(input);
  return result.ok ? result.url : null;
}

// ── Read API ─────────────────────────────────────────────────────────────────

/**
 * Returns: [local-electron (if Electron is running it), default, ...user entries].
 * The local-electron entry is synthesized at call time from
 * state/local-opencode.runtime.json — never persisted to endpoints.json.
 */
export function listEndpoints(): ActiveEndpoint[] {
  const { endpoints } = readFile();
  const local = localEndpoint();
  return [
    ...(local ? [local] : []),
    defaultEndpoint(),
    ...endpoints.map((e) => ({ ...e, isDefault: false })),
  ];
}

/**
 * Returns the active endpoint, falling back to the default if no active id is
 * set OR if the active id is `local-electron` but the runtime.json isn't there
 * (e.g. the Electron child died). Re-reads runtime.json each call so a
 * password rotated by a new Electron launch is picked up immediately.
 */
export function getActiveEndpoint(): ActiveEndpoint {
  const { activeId, endpoints } = readFile();
  if (activeId === LOCAL_ELECTRON_ID) {
    const local = localEndpoint();
    if (local) return local;
    // Active points to a now-defunct local OpenCode; fall back to default.
    return defaultEndpoint();
  }
  if (!activeId || activeId === DEFAULT_ID) return defaultEndpoint();
  const found = endpoints.find((e) => e.id === activeId);
  if (!found) return defaultEndpoint();
  return { ...found, isDefault: false };
}

// ── Write API ────────────────────────────────────────────────────────────────

export function setActiveId(id: string | null): ActiveEndpoint {
  const data = readFile();
  if (!id || id === DEFAULT_ID) {
    data.activeId = null;
  } else if (id === LOCAL_ELECTRON_ID) {
    // Local OpenCode entry must be live right now for this to be a valid
    // switch. We DO persist the activeId so it survives UI restarts inside
    // the same Electron session.
    if (!localEndpoint()) {
      throw new Error('Local OpenCode is not running (Electron only)');
    }
    data.activeId = LOCAL_ELECTRON_ID;
  } else {
    const exists = data.endpoints.some((e) => e.id === id);
    if (!exists) throw new Error(`Endpoint not found: ${id}`);
    data.activeId = id;
  }
  writeFile(data);
  return getActiveEndpoint();
}

export type EndpointInput = { label: string; url: string; password?: string };

export function addEndpoint(input: EndpointInput): EndpointEntry {
  const label = input.label.trim();
  if (!label) throw new Error('Label is required');
  const url = normalizeEndpointUrl(input.url);
  if (!url) throw new Error('URL must be a valid http(s) URL');

  const data = readFile();
  const entry: EndpointEntry = {
    id: randomUUID(),
    label,
    url,
    ...(input.password ? { password: input.password } : {}),
  };
  data.endpoints.push(entry);
  writeFile(data);
  return entry;
}

export type EndpointPatch = {
  label?: string;
  url?: string;
  /** undefined = leave unchanged; null = clear; string = set */
  password?: string | null;
};

export function updateEndpoint(id: string, patch: EndpointPatch): EndpointEntry {
  if (id === DEFAULT_ID) throw new Error('Cannot edit the default endpoint');
  if (id === LOCAL_ELECTRON_ID) {
    throw new Error('Cannot edit the local Electron OpenCode entry (it is ephemeral and per-launch)');
  }

  const data = readFile();
  const idx = data.endpoints.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`Endpoint not found: ${id}`);
  const current = data.endpoints[idx];

  const next: EndpointEntry = { ...current };
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new Error('Label cannot be empty');
    next.label = label;
  }
  if (patch.url !== undefined) {
    const url = normalizeEndpointUrl(patch.url);
    if (!url) throw new Error('URL must be a valid http(s) URL');
    next.url = url;
  }
  if (patch.password === null) {
    delete next.password;
  } else if (typeof patch.password === 'string') {
    next.password = patch.password;
  }

  data.endpoints[idx] = next;
  writeFile(data);
  return next;
}

export function deleteEndpoint(id: string): void {
  if (id === DEFAULT_ID) throw new Error('Cannot delete the default endpoint');
  if (id === LOCAL_ELECTRON_ID) {
    throw new Error('Cannot delete the local Electron OpenCode entry (managed by Electron lifecycle)');
  }
  const data = readFile();
  const idx = data.endpoints.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`Endpoint not found: ${id}`);
  data.endpoints.splice(idx, 1);
  if (data.activeId === id) data.activeId = null;
  writeFile(data);
}

async function probeEndpoint(endpoint: ActiveEndpoint): Promise<RemoteStatus> {
  const headers = new Headers();
  if (endpoint.password) {
    const username = endpoint.username ?? 'openpalm';
    headers.set('authorization', `Basic ${Buffer.from(`${username}:${endpoint.password}`).toString('base64')}`);
  }
  try {
    const response = await fetch(endpoint.url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { id: endpoint.id, name: endpoint.label, url: endpoint.url, state: 'unauthorized', detail: `HTTP ${response.status}` };
    }
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      return { id: endpoint.id, name: endpoint.label, url: endpoint.url, state: 'accessible' };
    }
    return { id: endpoint.id, name: endpoint.label, url: endpoint.url, state: 'unreachable', detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      id: endpoint.id,
      name: endpoint.label,
      url: endpoint.url,
      state: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listRemoteStatuses(): Promise<RemoteStatus[]> {
  if (remoteStatusCache && remoteStatusCache.expiresAt > Date.now()) {
    return remoteStatusCache.value.map((status) => ({ ...status }));
  }
  const statuses = await Promise.all(listEndpoints().map((endpoint) => probeEndpoint(endpoint)));
  remoteStatusCache = { value: statuses, expiresAt: Date.now() + 5_000 };
  return statuses.map((status) => ({ ...status }));
}
