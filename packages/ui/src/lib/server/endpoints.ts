/**
 * Assistant endpoints — list of OpenCode servers the UI can target, with
 * one marked active. The "default" entry is synthesized from environment
 * (OP_OPENCODE_URL / OP_ASSISTANT_URL / OP_ASSISTANT_PORT) and cannot be
 * deleted. User-added endpoints are persisted to a JSON file under the
 * state directory.
 *
 * File: ${stateDir}/admin/endpoints.json (mode 0600)
 * Shape: { activeId: string | null, endpoints: EndpointEntry[] }
 *   - activeId === null or "default" → use the env-derived default
 *   - activeId === "<id>" → use the matching user entry (falls back to default if not found)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getState } from './state.js';

export type EndpointEntry = {
  id: string;
  label: string;
  url: string;
  /** Optional OpenCode Basic-auth password forwarded as Authorization header. */
  password?: string;
};

export type ActiveEndpoint = EndpointEntry & {
  /** True for the env-derived default entry (cannot be edited or deleted). */
  isDefault: boolean;
  /**
   * True for the Electron-spawned ephemeral local OpenCode (Phase 3).
   * Synthesized at request time from state/local-opencode.runtime.json;
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

function endpointsPath(): string {
  return `${getState().stateDir}/admin/endpoints.json`;
}

function localRuntimePath(): string {
  return `${getState().stateDir}/local-opencode.runtime.json`;
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
    label: 'Local OpenCode (Electron)',
    url: rt.url,
    ...(rt.password ? { password: rt.password } : {}),
    isDefault: false,
    isLocal: true,
  };
}

function readFile(): EndpointsFile {
  const path = endpointsPath();
  if (!existsSync(path)) return { activeId: null, endpoints: [] };
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
    process.env.OP_OPENCODE_URL ??
    process.env.OP_ASSISTANT_URL ??
    `http://localhost:${process.env.OP_ASSISTANT_PORT ?? '3800'}`;
  const password = process.env.OPENCODE_SERVER_PASSWORD || undefined;
  return { id: DEFAULT_ID, label: 'Default (from environment)', url, password, isDefault: true };
}

/** Validate a URL string — must be http(s) with a host. Returns the normalized URL or null. */
export function normalizeEndpointUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    // Strip trailing slash for consistency
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
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
