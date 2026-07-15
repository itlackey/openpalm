import type { ConnectionEntry } from './connections/index.js';
import { isLoopbackHost, type BrowserOrigin } from './connections/url-policy.js';

export type AdvancedTarget =
  | { available: true; baseUrl: string }
  | {
      available: false;
      reason:
        | 'no-connection'
        | 'guardian-api'
        | 'credentialed-opencode'
        | 'mixed-content'
        | 'invalid-url';
      message: string;
    };

/**
 * Resolve whether the static client can honestly embed a connection's raw
 * OpenCode UI. An iframe navigation cannot attach the Authorization header
 * held by the client's encrypted secret store, and Guardian's /oc edge is an
 * allowlisted API rather than a web-UI reverse proxy.
 */
export function resolveAdvancedTarget(
  connection: ConnectionEntry | null,
  origin: BrowserOrigin | null = globalThis.location ?? null
): AdvancedTarget {
  if (!connection) {
    return {
      available: false,
      reason: 'no-connection',
      message: 'Choose a connection before opening Advanced mode.',
    };
  }

  if (connection.kind === 'openpalm-client-api') {
    return {
      available: false,
      reason: 'guardian-api',
      message:
        'This connection uses the Guardian chat API. Guardian does not expose the raw OpenCode web UI, so Advanced mode is unavailable for this connection.',
    };
  }

  if (connection.auth.mode !== 'none') {
    return {
      available: false,
      reason: 'credentialed-opencode',
      message:
        'This OpenCode connection requires a stored credential. Advanced mode cannot safely attach that credential to an embedded page; continue in Chat instead.',
    };
  }

  try {
    const url = new URL(connection.url);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search
    ) {
      throw new Error('unsafe advanced URL');
    }
    if (origin?.protocol === 'https:' && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      return {
        available: false,
        reason: 'mixed-content',
        message:
          'Advanced mode cannot embed this plain-HTTP remote server because this app is running over HTTPS. Use HTTPS for the OpenCode connection or continue in Chat.',
      };
    }
    url.hash = '';
    return { available: true, baseUrl: url.toString().replace(/\/$/, '') };
  } catch {
    return {
      available: false,
      reason: 'invalid-url',
      message: 'This connection does not have a safe HTTP(S) URL for Advanced mode.',
    };
  }
}

function encodeWorkspacePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/g, '');
}

/** Build a credential-free OpenCode web-UI URL, optionally deep-linked. */
export function buildAdvancedFrameUrl(
  baseUrl: string,
  sessionId?: string | null,
  directory?: string | null
): string {
  const url = new URL(baseUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (sessionId && directory) {
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath}/${encodeWorkspacePath(directory)}/session/${encodeURIComponent(sessionId)}`;
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Resolve a session's real workspace before deep-linking. The lookup is
 * deliberately credential-free; callers only invoke this for an available
 * raw OpenCode target.
 */
export async function resolveAdvancedFrameUrl(
  baseUrl: string,
  sessionId: string | null,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  if (!sessionId) return buildAdvancedFrameUrl(baseUrl);
  const sessionUrl = new URL(baseUrl);
  sessionUrl.search = '';
  sessionUrl.hash = '';
  sessionUrl.pathname = `${sessionUrl.pathname.replace(/\/+$/, '')}/session/${encodeURIComponent(sessionId)}`;
  try {
    const response = await fetchImpl(sessionUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return buildAdvancedFrameUrl(baseUrl);
    const body = (await response.json()) as { directory?: unknown };
    return buildAdvancedFrameUrl(
      baseUrl,
      sessionId,
      typeof body.directory === 'string' ? body.directory : null
    );
  } catch {
    return buildAdvancedFrameUrl(baseUrl);
  }
}

export function buildAdvancedPath(sessionId?: string | null): string {
  return sessionId ? `/advanced?session=${encodeURIComponent(sessionId)}` : '/advanced';
}

export function buildChatPath(sessionId?: string | null): string {
  return sessionId ? `/chat?session=${encodeURIComponent(sessionId)}` : '/chat';
}
