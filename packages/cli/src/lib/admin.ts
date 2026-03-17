import { loadAdminToken } from './env.ts';

export const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || 'http://localhost:8100';

/**
 * Returns true if the admin health endpoint is reachable.
 */
export async function isAdminReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${ADMIN_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @deprecated Use isAdminReachable() instead. Kept for backward compatibility.
 */
export const isStackRunning = isAdminReachable;

/**
 * Makes an authenticated request to the admin API.
 * Throws if the response is not ok.
 */
export async function adminRequest(path: string, init?: RequestInit): Promise<unknown> {
  const token = await loadAdminToken();
  if (!token) {
    throw new Error(
      'No admin token found. Set OPENPALM_ADMIN_TOKEN in your environment or ' +
      `configure it in secrets.env via the setup wizard (${ADMIN_URL}/setup).`,
    );
  }
  const response = await fetch(`${ADMIN_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-By': 'cli',
      'X-Admin-Token': token,
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  if (!text) return { ok: true };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Try to delegate an operation to the admin API.
 * Returns the result if admin is reachable and has a valid token.
 * Returns null if admin is unreachable or no token is available.
 * Attempts the request directly — no separate health check round-trip.
 */
export async function tryAdminRequest(path: string, init?: RequestInit): Promise<unknown | null> {
  const token = await loadAdminToken();
  if (!token) return null;

  try {
    return await adminRequest(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

/**
 * Waits for the admin health endpoint to become healthy (up to 120s).
 */
export async function waitForAdminHealthy(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (await isAdminReachable()) {
      return;
    }
    await Bun.sleep(3000);
  }
  throw new Error('Admin did not become healthy within 120 seconds');
}

/**
 * Extracts service names from an admin containers/list response.
 */
export function getServiceNames(status: unknown): string[] {
  if (!status || typeof status !== 'object' || !('containers' in status)) {
    return [];
  }
  const containers = (status as { containers?: unknown }).containers;
  if (!containers || typeof containers !== 'object') {
    return [];
  }
  return Object.keys(containers as Record<string, unknown>);
}
