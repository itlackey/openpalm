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

export function buildAdvancedPath(sessionId?: string | null): string {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set('session', sessionId);
  }
  const query = params.toString();
  return query ? `/advanced?${query}` : '/advanced';
}

export function buildChatPath(sessionId?: string | null): string {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set('session', sessionId);
  }
  const query = params.toString();
  return query ? `/chat?${query}` : '/chat';
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
