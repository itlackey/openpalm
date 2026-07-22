/**
 * Minimal browser-owned direct transport (Phase 3a — "One UI, delete the
 * split").
 *
 * Talks to a connection's OpenCode/Guardian base URL directly from the
 * browser — no proxy, NO COOKIES (`credentials: 'omit'`). This is deliberately
 * small: it exposes only the calls the ui chat layer needs and REUSES ui's
 * existing SSE frame parser (`$lib/chat/session-events.ts` `parseFrame`) and
 * event envelope type (`$lib/chat/oc-events.ts` `RawEvent`) rather than
 * re-implementing them. Reconnect/backoff and session-scoped filtering are the
 * chat layer's concern, not this transport's.
 */
import { parseFrame } from '../chat/session-events.js';
import type { RawEvent } from '../chat/oc-events.js';
import { validateConnectionUrl } from '../connections/url-policy.js';
import type { Connection } from '../connections/store.js';

/**
 * Resolved (usable) auth for a single request — the password is present here,
 * unlike the stored `ConnectionAuth` which only references it. Produced by the
 * secret store's `resolveAuth`.
 */
export type ResolvedAuth =
  | { mode: 'none' }
  | { mode: 'basic'; username?: string; password: string };

export type HealthProbeResult = {
  status: 'accessible' | 'unauthorized' | 'unreachable' | 'insecure';
};

export type CandidateVerificationResult = {
  status:
    | 'verified'
    | 'credentials-rejected'
    | 'wrong-endpoint'
    | 'rate-limited'
    | 'target-not-ready'
    | 'mixed-content'
    | 'network-uncertain';
};

export type DirectTransport = {
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response>;
  /**
   * Open the connection's `/event` SSE stream and invoke `onFrame` for every
   * parsed OpenCode event. Resolves when the stream ends or `signal` aborts;
   * the caller owns reconnect.
   */
  subscribeEvents(onFrame: (event: RawEvent) => void, signal: AbortSignal): Promise<void>;
  probeHealth(): Promise<HealthProbeResult>;
};

const PROBE_TIMEOUT_MS = 5_000;

/**
 * UTF-8-encode before base64ing: `btoa()` alone only accepts Latin-1 code
 * points and throws a synchronous `InvalidCharacterError` for any password
 * containing e.g. Cyrillic/CJK/emoji characters, before any network I/O.
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Build the `Authorization` header value for a resolved auth, or null for
 * `{ mode: 'none' }`. Basic username defaults to `'opencode'` (OpenCode's own
 * server default and what the host app sends).
 */
export function authorizationHeader(auth: ResolvedAuth): string | null {
  if (auth.mode === 'basic') {
    const username = auth.username ?? 'opencode';
    return `Basic ${base64Utf8(`${username}:${auth.password}`)}`;
  }
  return null;
}

function isSessionList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (session) =>
        typeof session === 'object' &&
        session !== null &&
        typeof (session as { id?: unknown }).id === 'string' &&
        (session as { id: string }).id.length > 0
    )
  );
}

/** Verify an ephemeral candidate without making it the active connection. */
export async function verifyDirectCandidate(
  baseUrl: string,
  auth: ResolvedAuth,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<CandidateVerificationResult> {
  const verdict = validateConnectionUrl(baseUrl);
  if (!verdict.ok) {
    return { status: verdict.reason === 'insecure-remote' ? 'mixed-content' : 'wrong-endpoint' };
  }

  const authorization = authorizationHeader(auth);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/session`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'credentials-rejected' };
    }
    if (response.status === 429) return { status: 'rate-limited' };
    if (response.status >= 500) return { status: 'target-not-ready' };
    if (!response.ok) return { status: 'wrong-endpoint' };

    try {
      return isSessionList(await response.json())
        ? { status: 'verified' }
        : { status: 'wrong-endpoint' };
    } catch {
      return { status: 'wrong-endpoint' };
    }
  } catch {
    return { status: 'network-uncertain' };
  }
}

export function createDirectTransport(
  getConnection: () => Connection | null,
  resolveAuth: (connection: Connection) => Promise<{ authorization?: string }>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): DirectTransport {
  function requireConnection(): Connection {
    const connection = getConnection();
    if (!connection) throw new Error('No active connection');
    return connection;
  }

  /** Trailing-slash and path-prefix safe: reverse-proxied instances keep their prefix. */
  function baseFor(connection: Connection): string {
    return connection.baseUrl.replace(/\/+$/, '');
  }

  async function authHeaders(connection: Connection): Promise<Record<string, string>> {
    const { authorization } = await resolveAuth(connection);
    return authorization ? { authorization } : {};
  }

  return {
    async request(method, path, body) {
      const connection = requireConnection();
      const headers: Record<string, string> = {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(await authHeaders(connection)),
      };
      const init: RequestInit = { method, headers, credentials: 'omit' };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetchImpl(`${baseFor(connection)}${path}`, init);
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      }
      return response;
    },

    async subscribeEvents(onFrame, signal) {
      const connection = requireConnection();
      const response = await fetchImpl(`${baseFor(connection)}/event`, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...(await authHeaders(connection)) },
        credentials: 'omit',
        signal,
      });
      if (!response.ok || !response.body) {
        throw Object.assign(new Error(`SSE stream failed: HTTP ${response.status}`), {
          status: response.status,
        });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            if (!chunk) continue;
            const frame = parseFrame(chunk);
            if (!frame.data) continue;
            let event: RawEvent;
            try {
              event = JSON.parse(frame.data) as RawEvent;
            } catch {
              continue;
            }
            onFrame(event);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    },

    async probeHealth() {
      const connection = getConnection();
      if (!connection) return { status: 'unreachable' };
      const base = baseFor(connection);
      // A plain-http remote target on an https app origin is mixed-content
      // blocked before the request ever leaves the browser — short-circuit
      // with zero network I/O rather than surface a misleading 'unreachable'.
      const verdict = validateConnectionUrl(base);
      if (!verdict.ok && verdict.reason === 'insecure-remote') {
        return { status: 'insecure' };
      }
      try {
        const response = await fetchImpl(`${base}/`, {
          method: 'GET',
          headers: await authHeaders(connection),
          credentials: 'omit',
          // 'no-store' never enters Cache Storage — a service worker's runtime
          // cache must not serve a stale probe through a real outage.
          cache: 'no-store',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
        if (response.ok || (response.status >= 300 && response.status < 400)) {
          return { status: 'accessible' };
        }
        return { status: 'unreachable' };
      } catch {
        return { status: 'unreachable' };
      }
    },
  };
}
