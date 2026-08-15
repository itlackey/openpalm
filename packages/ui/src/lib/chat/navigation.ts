import { chat } from '$lib/chat/chat-state.svelte.js';
import { buildAdvancedPath, buildChatPath } from '$lib/conversation-paths.js';

export { buildAdvancedPath, buildChatPath } from '$lib/conversation-paths.js';

export function currentChatSessionId(): string | null {
  return chat.activeSessionId;
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

