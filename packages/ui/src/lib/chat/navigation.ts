import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
import { chat } from '$lib/chat/chat-state.svelte.js';

const DEFAULT_WORKSPACE_PATH = '/work/itlackey/openpalm';

function encodeWorkspacePath(path: string): string {
  if (typeof window === 'undefined' || typeof window.btoa !== 'function') {
    return 'L3dvcmsvaXRsYWNrZXkvb3BlbnBhbG0';
  }

  const bytes = new TextEncoder().encode(path);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary).replace(/=+$/g, '');
}

export function currentChatSessionId(): string | null {
  return chat.activeSessionId;
}

export function preferredChatPath(): '/chat' | '/advanced' {
  return advancedModeService.preferredChatPath();
}

export function buildAdvancedPath(sessionId?: string | null): string {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set('session', sessionId);
  }
  const query = params.toString();
  return query ? `/advanced?${query}` : '/advanced';
}

export function buildChatPath(sessionId?: string | null, options?: { newChat?: boolean }): string {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set('session', sessionId);
  }
  if (options?.newChat) {
    params.set('new', '1');
  }
  const query = params.toString();
  return query ? `/chat?${query}` : '/chat';
}

export function buildAdvancedIframeUrl(baseUrl: string, sessionId?: string | null): string {
  if (!sessionId) return baseUrl;

  const trimmedBase = baseUrl.replace(/\/$/, '');
  const workspaceSegment = encodeWorkspacePath(DEFAULT_WORKSPACE_PATH);
  return `${trimmedBase}/${workspaceSegment}/session/${encodeURIComponent(sessionId)}`;
}
