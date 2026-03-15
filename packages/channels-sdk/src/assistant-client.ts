/**
 * Shared assistant HTTP client — used by the scheduler (admin/Node)
 * and the guardian (Bun) to create OpenCode sessions and send messages.
 *
 * Uses standard `fetch()` so it works in both Node.js and Bun runtimes.
 */

export interface AssistantClientOptions {
  /** Base URL of the OpenCode server. */
  baseUrl: string;
  /** Optional Basic-auth username (defaults to "opencode"). */
  username?: string;
  /** Optional Basic-auth password. If unset, no Authorization header is sent. */
  password?: string;
  /** Timeout for the session-create request (ms). Default: 10 000. */
  createTimeoutMs?: number;
  /** Timeout for the message request (ms). Default: 120 000. */
  messageTimeoutMs?: number;
}

interface SessionCreateResponse {
  id: string;
}

interface SessionListItemResponse {
  id?: unknown;
  title?: unknown;
}

interface MessageResponse {
  info?: unknown;
  parts?: Array<{ type: string; text?: string; content?: string }>;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface AssistantSessionSummary {
  id: string;
  title: string;
}

/**
 * Produce a short human-readable description for an assistant HTTP error.
 * Prefers the response body when it contains a useful message; otherwise
 * maps common status codes to plain-language descriptions.
 */
function describeAssistantError(status: number, body: string): string {
  // Try to extract a structured error message from the body
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
      // Not JSON — use the raw body if it is short enough to be useful
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
    default:  return body || `Unexpected error (HTTP ${status})`;
  }
}

function buildAuthHeader(username: string, password: string): string {
  const credentials = `${username}:${password}`;
  const encoded = Buffer.from(credentials, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function buildHeaders(opts: AssistantClientOptions): Record<string, string> {
  const { username = "opencode", password } = opts;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (password) {
    headers["authorization"] = buildAuthHeader(username, password);
  }
  return headers;
}

/**
 * Create a new assistant session. Returns the session ID.
 */
export async function createSession(
  opts: AssistantClientOptions,
  title: string,
): Promise<string> {
  const { baseUrl, createTimeoutMs = 10_000 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), createTimeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Assistant session creation failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`,
      );
    }
    const session = (await resp.json()) as SessionCreateResponse;
    const sessionId = session.id;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      throw new Error("Invalid session ID from assistant");
    }
    return sessionId;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List assistant sessions and return their IDs and titles.
 */
export async function listSessions(
  opts: AssistantClientOptions,
): Promise<AssistantSessionSummary[]> {
  const { baseUrl, createTimeoutMs = 10_000 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), createTimeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/session`, {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Assistant session listing failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`,
      );
    }

    const data = await resp.json() as unknown;
    if (!Array.isArray(data)) {
      throw new Error("Invalid session list from assistant");
    }

    const sessions: AssistantSessionSummary[] = [];
    for (const item of data) {
      const record = item as SessionListItemResponse;
      if (typeof record.id !== "string" || !SESSION_ID_RE.test(record.id)) continue;
      if (typeof record.title !== "string") continue;
      sessions.push({ id: record.id, title: record.title });
    }
    return sessions;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete an assistant session. Returns false when the session no longer exists.
 */
export async function deleteSession(
  opts: AssistantClientOptions,
  sessionId: string,
): Promise<boolean> {
  const { baseUrl, createTimeoutMs = 10_000 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), createTimeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/session/${sessionId}`, {
      method: "DELETE",
      headers,
      signal: ctrl.signal,
    });
    if (resp.status === 404) return false;
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Assistant session deletion failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`,
      );
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a message to an existing assistant session. Returns the answer text.
 */
export async function sendMessage(
  opts: AssistantClientOptions,
  sessionId: string,
  prompt: string,
): Promise<string> {
  const { baseUrl, messageTimeoutMs = 120_000 } = opts;
  const headers = buildHeaders(opts);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), messageTimeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Assistant message failed (HTTP ${resp.status}): ${describeAssistantError(resp.status, body)}`,
      );
    }
    const data = (await resp.json()) as MessageResponse;

    const texts: string[] = [];
    for (const part of data.parts ?? []) {
      if (part.type === "text" && part.text) {
        texts.push(part.text);
      }
    }
    return texts.join("\n") || "(no response)";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a one-shot assistant session client.
 *
 * Usage:
 *   const answer = await askAssistant(opts, title, prompt);
 */
export async function askAssistant(
  opts: AssistantClientOptions,
  title: string,
  prompt: string,
): Promise<string> {
  const sessionId = await createSession(opts, title);
  return sendMessage(opts, sessionId, prompt);
}
