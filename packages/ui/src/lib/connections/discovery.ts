/**
 * Localhost assistant auto-discovery.
 *
 * The connections list is browser-owned; the only automatic entry is the
 * locked default seeded from runtime-config.json, which exists only when a
 * launcher wrote that file. When the UI runs without one (standalone PWA,
 * Electron without a local stack), a locally-running OpenPalm assistant is
 * invisible until the user types its URL by hand. This module probes the two
 * well-known local endpoints — the direct assistant port and the guardian
 * front door — and adds the first reachable one as an ordinary (unlocked,
 * user-removable) connection.
 *
 * Loopback targets are exempt from the browser's mixed-content rule
 * ("potentially trustworthy" origins), so the probes are safe from any app
 * origin. Probes never carry credentials and treat 401/403 as "present" — a
 * guardian front door challenges anonymous requests but is still a valid
 * connection target (the user attaches credentials afterwards).
 *
 * Removal is respected: deleting a discovered connection records a dismissal
 * flag (localStorage — a per-browser preference, like the theme), and
 * discovery never runs again on that browser until connections data is
 * cleared.
 */

import type { Connection, ConnectionStore } from './store.js';
import { isLoopbackHost } from './url-policy.js';

export type DiscoveryCandidate = { baseUrl: string; label: string };

/** Probed in order; the first reachable candidate is added. Ports are the
 * stack defaults (`STACK_DEFAULTS.ports.assistant`, guardian direct port). */
export const LOCAL_DISCOVERY_CANDIDATES: readonly DiscoveryCandidate[] = [
  { baseUrl: 'http://127.0.0.1:3810', label: 'Local assistant' },
  { baseUrl: 'http://127.0.0.1:3830/oc', label: 'Local assistant (guardian)' },
];

const DISMISSED_STORAGE_KEY = 'openpalm.connections.local-discovery-dismissed';
const PROBE_TIMEOUT_MS = 1500;

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some privacy modes throw on localStorage access.
    return null;
  }
}

export function isLocalDiscoveryDismissed(): boolean {
  return safeLocalStorage()?.getItem(DISMISSED_STORAGE_KEY) === '1';
}

export function markLocalDiscoveryDismissed(): void {
  try {
    safeLocalStorage()?.setItem(DISMISSED_STORAGE_KEY, '1');
  } catch {
    // Best-effort: a full/blocked storage just means discovery may re-offer.
  }
}

/**
 * Normalize a base URL for identity comparison: loopback spellings collapse
 * to one host, default ports are made explicit, trailing slashes dropped.
 */
function normalizeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = isLoopbackHost(url.hostname) ? '127.0.0.1' : url.hostname.toLowerCase();
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${host}:${port}${path}`;
  } catch {
    return null;
  }
}

/** True when `url` names one of the discovery candidates (used by the
 * connections page to record a dismissal when such an entry is removed). */
export function isDiscoveryCandidateUrl(url: string): boolean {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return false;
  return LOCAL_DISCOVERY_CANDIDATES.some((c) => normalizeBaseUrl(c.baseUrl) === normalized);
}

async function probe(baseUrl: string, fetchImpl: typeof globalThis.fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Same acceptance as DirectTransport.probeHealth: a 401/403 means an
    // auth-fronted server IS there; 3xx means something answered. A 404 or
    // 5xx is "some other service on that port" — not an assistant.
    if (response.status === 401 || response.status === 403) return true;
    return response.ok || (response.status >= 300 && response.status < 400);
  } catch {
    return false;
  }
}

/**
 * Probe the well-known local endpoints and add the first reachable one to
 * `store` as an unlocked connection — unless the list already contains a
 * local (loopback) connection, or the user previously removed a discovered
 * entry. Returns the added connection, or null when nothing was added.
 * Never throws: discovery is strictly best-effort.
 */
export async function discoverLocalAssistant(
  store: ConnectionStore,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<Connection | null> {
  try {
    if (typeof fetchImpl !== 'function') return null;
    if (isLocalDiscoveryDismissed()) return null;

    const hasLocal = async (): Promise<boolean> =>
      (await store.list()).some((c) => {
        try {
          return isLoopbackHost(new URL(c.baseUrl).hostname);
        } catch {
          return false;
        }
      });
    if (await hasLocal()) return null;

    for (const candidate of LOCAL_DISCOVERY_CANDIDATES) {
      if (!(await probe(candidate.baseUrl, fetchImpl))) continue;
      // Re-check right before adding: the probe can take seconds, and the
      // user may have added a loopback connection (form or pairing code) in
      // the meantime — don't create a duplicate.
      if (await hasLocal()) return null;
      return await store.add({
        label: candidate.label,
        baseUrl: candidate.baseUrl,
        auth: { mode: 'none' },
      });
    }
    return null;
  } catch {
    return null;
  }
}
