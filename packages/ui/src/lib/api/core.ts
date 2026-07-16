// ── Shared transport core ─────────────────────────────────────────────────
// The single fetch primitive and error-handling helpers every domain client
// module builds on. Owns no endpoints and no feature DTOs — just transport.

import { randomId } from '../random-id.js';

const apiBase = '';

export function buildHeaders(): HeadersInit {
  return {
    // randomId, not bare crypto.randomUUID(): randomUUID is
    // secure-context-only and would throw on the plain-http LAN tier,
    // breaking EVERY API call from that origin.
    'x-request-id': randomId(),
    'x-requested-by': 'ui'
  };
}

export async function request(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<Response> {
  const headers: HeadersInit = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...buildHeaders()
  };
  return fetch(`${apiBase}${path}`, {
    // Caller-supplied fields (e.g. an AbortSignal) go first so the computed
    // method/headers/credentials/body below stay authoritative.
    ...init,
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

export async function readErrorMessage(
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
export async function requireOk(res: Response, fallback?: string): Promise<Response> {
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(await readErrorMessage(res, fallback)), { status: res.status });
  }
  return res;
}

/**
 * `requireOk` variant for endpoints whose non-OK responses still carry a
 * structured JSON body the caller must read (e.g. a 502 that reports which
 * individual services failed). Throws on 401 and when the body is NOT JSON
 * (falling back to `readErrorMessage`), but otherwise returns the parsed body
 * regardless of HTTP status so the caller can branch on it.
 */
export async function requireJsonBody<T>(res: Response, fallback: string): Promise<T> {
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // Non-JSON error (e.g. 500 HTML). Fall back to the generic helper.
    throw new Error(await readErrorMessage(res, fallback));
  }
  return (await res.json()) as T;
}
