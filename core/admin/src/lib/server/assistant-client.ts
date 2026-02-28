/**
 * OpenCode assistant client — sends prompts and receives responses.
 *
 * Uses the OpenCode Server REST API (same two-step pattern as guardian):
 *   1. POST /session → create session → { id }
 *   2. POST /session/:id/message → send message → { parts }
 *
 * The admin reaches the assistant at OPENPALM_ASSISTANT_URL (http://assistant:4096).
 */

const ASSISTANT_URL = process.env.OPENPALM_ASSISTANT_URL ?? "http://assistant:4096";
const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_CREATE_TIMEOUT_MS = 10_000;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export type AssistantResponse = {
  ok: boolean;
  sessionId: string | null;
  text: string;
  durationMs: number;
  error?: string;
};

/**
 * Send a prompt to the assistant and wait for a response.
 * Creates a new session, sends the prompt, and extracts text from response parts.
 */
export async function sendPromptToAssistant(
  prompt: string,
  options?: {
    title?: string;
    timeoutMs?: number;
  }
): Promise<AssistantResponse> {
  const start = Date.now();
  const title = options?.title ?? "automation";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let sessionId: string | null = null;

  try {
    // Step 1: Create a session
    const createCtrl = new AbortController();
    const createTimer = setTimeout(() => createCtrl.abort(), SESSION_CREATE_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ASSISTANT_URL}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: createCtrl.signal,
        body: JSON.stringify({ title }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`assistant POST /session ${resp.status}: ${body}`);
      }
      const session = (await resp.json()) as { id: string };
      sessionId = session.id;
      if (!SESSION_ID_RE.test(sessionId)) {
        throw new Error("Invalid session ID from assistant");
      }
    } finally {
      clearTimeout(createTimer);
    }

    // Step 2: Send the prompt and wait for response
    const msgCtrl = new AbortController();
    const msgTimer = setTimeout(() => msgCtrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${ASSISTANT_URL}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: msgCtrl.signal,
        body: JSON.stringify({
          parts: [{ type: "text", text: prompt }],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`assistant POST /session/${sessionId}/message ${resp.status}: ${body}`);
      }
      const data = (await resp.json()) as {
        info: unknown;
        parts: Array<{ type: string; text?: string; content?: string }>;
      };

      // Extract text from response parts
      const texts: string[] = [];
      for (const part of data.parts ?? []) {
        if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
      }

      return {
        ok: true,
        sessionId,
        text: texts.join("\n") || "(no response)",
        durationMs: Date.now() - start,
      };
    } finally {
      clearTimeout(msgTimer);
    }
  } catch (err) {
    return {
      ok: false,
      sessionId,
      text: "",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
