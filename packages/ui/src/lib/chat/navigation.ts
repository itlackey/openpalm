import { chat } from '$lib/chat/chat-state.svelte.js';

function encodeWorkspacePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  // btoa exists in the browser and in Node ≥16 (SSR); no hardcoded fallback.
  return btoa(binary).replace(/=+$/g, '');
}

export function currentChatSessionId(): string | null {
  return chat.activeSessionId;
}

function buildModePath(
  pathname: '/chat' | '/advanced',
  sessionId?: string | null,
  assistantId?: string | null,
): string {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set('session', sessionId);
  }
  if (assistantId) {
    params.set('assistant', assistantId);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildAdvancedPath(sessionId?: string | null, assistantId?: string | null): string {
  return buildModePath('/advanced', sessionId, assistantId);
}

export function buildChatPath(sessionId?: string | null, assistantId?: string | null): string {
  return buildModePath('/chat', sessionId, assistantId);
}

/** Keep session navigation on the current simple or advanced chat surface. */
export function buildConversationPath(
  pathname: string,
  sessionId?: string | null,
  assistantId?: string | null,
): string {
  return pathname === '/advanced' || pathname.startsWith('/advanced/')
    ? buildAdvancedPath(sessionId, assistantId)
    : buildChatPath(sessionId, assistantId);
}

export function buildReturnToPath(destination: string, returnTo: string): string {
  const hashIndex = destination.indexOf('#');
  const fragment = hashIndex === -1 ? '' : destination.slice(hashIndex);
  const pathAndQuery = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf('?');
  const path = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : pathAndQuery.slice(queryIndex + 1));
  params.set('returnTo', returnTo);
  return `${path}?${params.toString()}${fragment}`;
}

function internalConversationPath(path: string | null | undefined): string | null {
  if (!path?.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;

  try {
    const base = new URL('http://openpalm.invalid');
    const target = new URL(path, base);
    if (target.origin !== base.origin) return null;
    if (target.pathname !== '/chat' && target.pathname !== '/advanced') return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

export function resolveReturnToPath(
  returnTo: string | null | undefined,
  fallback = buildChatPath(currentChatSessionId(), chat.activeEndpointId),
): string {
  return (
    internalConversationPath(returnTo) ??
    internalConversationPath(fallback) ??
    buildChatPath(currentChatSessionId(), chat.activeEndpointId)
  );
}

/**
 * Build the OpenCode web-UI deep link to a specific session. OpenCode scopes its
 * session list by directory, so the route is `/<base64(directory)>/session/<id>`
 * and the `directory` MUST be the workspace the session actually lives in —
 * resolve it from the session record (`session.directory`), never hardcode it.
 * Without a session id or directory, fall back to the base URL (OpenCode opens
 * its default view) so we never deep-link a session the embedded app can't find.
 */
export function buildAdvancedIframeUrl(
  baseUrl: string,
  sessionId?: string | null,
  directory?: string | null,
): string {
  if (!sessionId || !directory) return baseUrl;

  const trimmedBase = baseUrl.replace(/\/$/, '');
  const workspaceSegment = encodeWorkspacePath(directory);
  return `${trimmedBase}/${workspaceSegment}/session/${encodeURIComponent(sessionId)}`;
}
