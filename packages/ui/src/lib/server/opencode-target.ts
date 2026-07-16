/**
 * The host's OWN OpenCode target — the local admin assistant the host UI's
 * server routes talk to (config, catalog, health, landing reachability).
 *
 * Phase 3b ("One UI, delete the split"): the browser owns connections and talks
 * to OpenCode directly, so the host connection STORE (`endpoints.json` CRUD +
 * the host assistant proxy broker + the `/api/connections` list/switch surface)
 * is gone. What remains is this: the host process still runs (or points at) one
 * local OpenCode, derived from environment — or, under Electron, the
 * per-launch child advertised in `local-opencode.runtime.json`.
 *
 * This is deliberately small: env/runtime derivation + a liveness probe + a URL
 * validator (for the surviving pairing MINT route). No persistence, no active
 * selection, no user entries — those belong to the browser now.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getState } from './state.js';
import { readSecret, readStackEnv, type RemoteStatus } from '@openpalm/lib';
import { basicAuthHeader, DEFAULT_OPENCODE_USERNAME, stripTrailingNewlines } from './basic-auth.js';

export type HostOpencodeTarget = {
  id: string;
  label: string;
  url: string;
  username?: string;
  password?: string;
  /** True for the env-derived default (as opposed to the Electron child). */
  isDefault: boolean;
};

const DEFAULT_ID = 'default';
const LOCAL_ELECTRON_ID = 'local-electron';

function normalizeBrowserFacingUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '0.0.0.0' || host === '::') {
      url.hostname = '127.0.0.1';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

type LocalRuntime = {
  url: string;
  username?: string;
  password?: string;
};

/**
 * Read the Electron-written runtime.json each time it's needed. The file is
 * 0600 and is rewritten on each Electron launch (random password per launch),
 * so callers must NOT cache the result.
 */
function readLocalRuntime(): LocalRuntime | null {
  const path = `${getState().dataDir}/local-opencode.runtime.json`;
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LocalRuntime>;
    if (!parsed || typeof parsed.url !== 'string' || !parsed.url) return null;
    return {
      url: parsed.url,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      password: typeof parsed.password === 'string' ? parsed.password : undefined,
    };
  } catch (e) {
    console.warn('[opencode-target] Failed to parse local-opencode.runtime.json:', e);
    return null;
  }
}

function localTarget(): HostOpencodeTarget | null {
  const rt = readLocalRuntime();
  if (!rt) return null;
  return {
    id: LOCAL_ELECTRON_ID,
    label: 'OpenPalm Admin',
    url: normalizeBrowserFacingUrl(rt.url),
    username: rt.username || DEFAULT_OPENCODE_USERNAME,
    ...(rt.password ? { password: rt.password } : {}),
    isDefault: false,
  };
}

function defaultTarget(): HostOpencodeTarget {
  const persisted = readStackEnv(getState().homeDir);
  const url =
    process.env.OP_OPENCODE_URL ??
    process.env.OP_ASSISTANT_URL ??
    `http://127.0.0.1:${process.env.OP_ASSISTANT_PORT ?? persisted.OP_ASSISTANT_PORT ?? '3800'}`;
  // OpenCode's server default username — the shipped assistant compose never
  // overrides OPENCODE_SERVER_USERNAME, and the guardian's upstream auth sends
  // 'opencode:<password>', so default here or a correct password 401s.
  const username = process.env.OPENCODE_SERVER_USERNAME || DEFAULT_OPENCODE_USERNAME;
  // An explicit host OPENCODE_SERVER_PASSWORD always wins. Otherwise fall back
  // to the network-preset-managed OpenCode password, but ONLY when
  // OPENCODE_AUTH is truthy (the secret file is always materialized). Read auth
  // from the same fresh sources as the URL, not frozen process.env.
  const authEnabled = /^(true|1|yes)$/i.test(
    (persisted.OPENCODE_AUTH ?? process.env.OPENCODE_AUTH ?? '').trim()
  );
  const presetPassword = authEnabled
    ? ((raw) => (raw ? stripTrailingNewlines(raw) : undefined))(
        readSecret(getState().homeDir, 'op_opencode_password') ?? undefined
      ) || process.env.OP_OPENCODE_PASSWORD
    : undefined;
  const password = process.env.OPENCODE_SERVER_PASSWORD || presetPassword || undefined;
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
 * The host's own OpenCode target: the Electron-spawned local child when its
 * runtime.json is present, otherwise the env-derived default. Re-read each call
 * so a password rotated by a new Electron launch is picked up immediately.
 */
export function getHostOpencodeTarget(): HostOpencodeTarget {
  return localTarget() ?? defaultTarget();
}

// ── URL validation (surviving pairing MINT route) ────────────────────────────

export type ConnectionUrlError =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'missing_host'
  | 'userinfo_not_allowed'
  | 'unexpected_query_or_fragment';

export type ConnectionUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: ConnectionUrlError };

/**
 * Discriminated validator for a connection/guardian BASE URL. Plain HTTP is
 * allowed for any host (OpenPalm is LAN-first). A query or fragment is rejected
 * because callers concatenate API paths onto the base (`${base}/session`).
 */
export function validateConnectionUrl(input: string): ConnectionUrlValidation {
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
  if (u.username || u.password) {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }
  if (u.search || u.hash) {
    return { ok: false, reason: 'unexpected_query_or_fragment' };
  }
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}

// ── Reachability probe (host-admin landing) ──────────────────────────────────

let remoteStatusCache: { expiresAt: number; value: RemoteStatus[] } | null = null;

async function probeTarget(target: HostOpencodeTarget): Promise<RemoteStatus> {
  const headers = new Headers();
  if (target.password) {
    headers.set('authorization', basicAuthHeader(target.username ?? DEFAULT_OPENCODE_USERNAME, target.password));
  }
  // The guardian is a transparent 1:1 OpenCode proxy, so `${url}/session` is a
  // valid liveness check for a raw OpenCode server and a guardian `/oc` base
  // alike (a guardian's bare root `GET /oc/` is not an allowlisted route).
  const probeUrl = `${target.url}/session`;
  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { id: target.id, name: target.label, url: target.url, state: 'unauthorized', detail: `HTTP ${response.status}` };
    }
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      return { id: target.id, name: target.label, url: target.url, state: 'accessible' };
    }
    return { id: target.id, name: target.label, url: target.url, state: 'unreachable', detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      id: target.id,
      name: target.label,
      url: target.url,
      state: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Probe the host's own OpenCode target, cached in-memory for 5s. Feeds the
 * host-admin landing's reachability signal (`deriveLaunchStatus`). Never
 * written to disk.
 */
export async function listRemoteStatuses(): Promise<RemoteStatus[]> {
  if (remoteStatusCache && remoteStatusCache.expiresAt > Date.now()) {
    return remoteStatusCache.value.map((status) => ({ ...status }));
  }
  const statuses = [await probeTarget(getHostOpencodeTarget())];
  remoteStatusCache = { value: statuses, expiresAt: Date.now() + 5_000 };
  return statuses.map((status) => ({ ...status }));
}
