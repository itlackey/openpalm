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

interface MessageResponse {
  info?: unknown;
  parts?: Array<{ type: string; text?: string; content?: string }>;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

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
      throw new Error(`assistant POST /session failed: ${resp.status}`);
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
      throw new Error(
        `assistant POST /session/${sessionId}/message failed: ${resp.status}`,
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
