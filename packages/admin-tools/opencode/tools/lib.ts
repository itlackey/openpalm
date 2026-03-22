const ADMIN_URL = process.env.OP_ADMIN_API_URL || 'http://admin:8100';
const MISSING_ASSISTANT_TOKEN = JSON.stringify({
  error: true,
  message: 'Missing OP_ASSISTANT_TOKEN. Admin-token fallback is disabled for assistant/admin-tools contexts.',
});

export function buildAdminHeaders(extraHeaders?: HeadersInit): Headers | null {
  const assistantToken = process.env.OP_ASSISTANT_TOKEN || '';
  if (!assistantToken) return null;

  const headers = new Headers(extraHeaders);
  headers.set('x-admin-token', assistantToken);
  headers.set('x-requested-by', 'assistant');
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return headers;
}

export async function adminFetch(path: string, options?: RequestInit): Promise<string> {
  const headers = buildAdminHeaders(options?.headers);
  if (!headers) return MISSING_ASSISTANT_TOKEN;

  try {
    const res = await fetch(`${ADMIN_URL}${path}`, {
      ...options,
      headers,
      signal: options?.signal ?? AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
    return body;
  } catch (err) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : String(err) });
  }
}
