function buildModePath(
  pathname: '/chat' | '/advanced',
  sessionId?: string | null,
  assistantId?: string | null,
): string {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  if (assistantId) params.set('assistant', assistantId);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildAdvancedPath(sessionId?: string | null, assistantId?: string | null): string {
  return buildModePath('/advanced', sessionId, assistantId);
}

export function buildChatPath(sessionId?: string | null, assistantId?: string | null): string {
  return buildModePath('/chat', sessionId, assistantId);
}
