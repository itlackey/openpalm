const TOKEN_KEY = 'openpalm.adminToken';

export function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export async function validateToken(
  token: string
): Promise<{ ok: boolean; allowed: boolean; error?: string }> {
  try {
    const res = await fetch('/admin/access-scope', {
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
  } catch {
    return { ok: false, allowed: false, error: 'Unable to reach admin API.' };
  }
}
