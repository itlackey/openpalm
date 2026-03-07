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
  // Works in both Node 18+ (global btoa) and Bun
  return `Basic ${btoa(`${username}:${password}`)}`;
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
  const {
    baseUrl,
    username = "opencode",
    password,
    createTimeoutMs = 10_000,
    messageTimeoutMs = 120_000,
  } = opts;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (password) {
    headers["authorization"] = buildAuthHeader(username, password);
  }

  // Step 1: Create a session
  const createCtrl = new AbortController();
  const createTimer = setTimeout(() => createCtrl.abort(), createTimeoutMs);
  let sessionId: string;
  try {
    const resp = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers,
      signal: createCtrl.signal,
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`assistant POST /session ${resp.status}: ${body}`);
    }
    const session = (await resp.json()) as SessionCreateResponse;
    sessionId = session.id;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      throw new Error("Invalid session ID from assistant");
    }
  } finally {
    clearTimeout(createTimer);
  }

  // Step 2: Send the prompt and wait for response
  const msgCtrl = new AbortController();
  const msgTimer = setTimeout(() => msgCtrl.abort(), messageTimeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers,
      signal: msgCtrl.signal,
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `assistant POST /session/${sessionId}/message ${resp.status}: ${body}`,
      );
    }
    const data = (await resp.json()) as MessageResponse;

    // Extract text from response parts
    const texts: string[] = [];
    for (const part of data.parts ?? []) {
      if (part.type === "text" && part.text) {
        texts.push(part.text);
      }
    }
    return texts.join("\n") || "(no response)";
  } finally {
    clearTimeout(msgTimer);
  }
}
