const TOKEN_KEY = 'openpalm.adminToken';

export function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  // Also clear session cookie (best-effort — httpOnly cookies cannot be cleared from JS)
  document.cookie = 'op_session=; Max-Age=0; path=/; SameSite=Strict';
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Request the host gateway to set a session cookie.
 * Only relevant when OPENPALM_ADMIN_MODE=host. No-ops silently in container mode
 * (the endpoint returns 404 which we ignore).
 */
export async function storeSessionCookie(token: string): Promise<void> {
  try {
    await fetch('/admin/auth/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
      },
      body: JSON.stringify({ token }),
    });
  } catch {
    // best-effort — container mode will return 404
  }
}

export async function validateToken(
  token: string
): Promise<{ ok: boolean; allowed: boolean; error?: string }> {
  try {
    const res = await fetch('/admin/capabilities/status', {
      headers: {
        'x-admin-token': token,
        'x-requested-by': 'ui',
        'x-request-id': crypto.randomUUID()
      }
    });
    if (res.ok) {
      return { ok: true, allowed: true };
    }
    if (res.status === 401) {
      return { ok: false, allowed: false, error: 'Invalid admin token.' };
    }
    return { ok: false, allowed: false, error: `Unexpected status: ${res.status}` };
  } catch (e) {
    console.warn('[auth] Unable to reach admin API', e);
    return { ok: false, allowed: false, error: 'Unable to reach admin API.' };
  }
}
