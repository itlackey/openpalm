export type AssistantClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  createTimeoutMs?: number;
  messageTimeoutMs?: number;
};

type SessionCreateResponse = {
  id: string;
};

type MessageResponse = {
  info?: unknown;
  parts?: Array<{ type: string; text?: string; content?: string }>;
};

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function describeAssistantError(status: number, body: string): string {
  if (body) {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      if (typeof json.message === 'string' && json.message) return json.message;
      if (typeof json.error === 'string' && json.error) return json.error;
      if (
        typeof json.error === 'object' && json.error !== null &&
        typeof (json.error as Record<string, unknown>).message === 'string'
      ) {
        return (json.error as Record<string, unknown>).message as string;
      }
    } catch {
      if (body.length <= 200) return body;
    }
  }
  switch (status) {
    case 401: return 'Authentication failed — check assistant credentials';
    case 403: return 'Access denied by the assistant';
    case 404: return 'Assistant endpoint not found — verify assistant is running';
    case 502: return 'Assistant upstream error — the LLM provider may be unreachable or returned an error';
    case 503: return 'Assistant is temporarily unavailable';
    case 504: return 'Assistant request timed out — the LLM provider may be slow or unreachable';
    default: return body || `Unexpected error (HTTP ${status})`;
  }
}

function buildAuthHeader(username: string, password: string): string {
  const credentials = `${username}:${password}`;
  const encoded = Buffer.from(credentials, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

function buildHeaders(opts: AssistantClientOptions): Record<string, string> {
  const { username = 'opencode', password } = opts;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (password) {
    headers.authorization = buildAuthHeader(username, password);
  }
  return headers;
}

export async function createSession(opts: AssistantClientOptions, title: string): Promise<string> {
  const { baseUrl, createTimeoutMs = 10_000 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), createTimeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Assistant session creation failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`);
    }
    const session = (await resp.json()) as SessionCreateResponse;
    const sessionId = session.id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      throw new Error('Invalid session ID from assistant');
    }
    return sessionId;
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteSession(opts: AssistantClientOptions, sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session ID for deletion');
  }
  const { baseUrl, createTimeoutMs = 10_000 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), createTimeoutMs);
  try {
    const encodedSessionId = encodeURIComponent(sessionId);
    const resp = await fetch(`${baseUrl}/session/${encodedSessionId}`, {
      method: 'DELETE',
      headers,
      signal: ctrl.signal,
    });
    if (resp.status === 404) return false;
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Assistant session deletion failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(opts: AssistantClientOptions, sessionId: string, prompt: string): Promise<string> {
  const { baseUrl, messageTimeoutMs = 0 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = messageTimeoutMs > 0 ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), messageTimeoutMs) : null;
  try {
    const encodedSessionId = encodeURIComponent(sessionId);
    const resp = await fetch(`${baseUrl}/session/${encodedSessionId}/message`, {
      method: 'POST',
      headers,
      ...(ctrl ? { signal: ctrl.signal } : {}),
      body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Assistant message failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`);
    }
    const raw = await resp.text();
    if (!raw) {
      console.error('[assistant-client] sendMessage: empty response body');
      return '(no response)';
    }
    const data = JSON.parse(raw) as MessageResponse | null;
    if (!data) {
      console.error('[assistant-client] sendMessage: parsed data is null');
      return '(no response)';
    }
    const texts: string[] = [];
    for (const part of data.parts ?? []) {
      if (part.type === 'text' && part.text) {
        texts.push(part.text);
      }
    }
    const result = texts.join('\n') || '(no response)';
    if (result === '(no response)') {
      console.error('[assistant-client] sendMessage: no text parts found. parts count:', (data.parts ?? []).length, 'types:', (data.parts ?? []).map((p) => p.type).join(','), 'raw length:', raw.length);
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
