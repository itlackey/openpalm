/**
 * Thin HTTP client for forwarding requests to the OpenCode agent runtime.
 * The gateway delegates all reasoning, tool use, and memory access to OpenCode.
 */

export type AgentRequest = {
  message: string;
  userId: string;
  sessionId: string;
  agent?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
};

export type AgentResponse = {
  response: string;
  sessionId: string;
  agent?: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 15_000);
const MAX_RETRIES = Number(Bun.env.OPENCODE_RETRIES ?? 2);
const RETRY_BASE_DELAY_MS = Number(Bun.env.OPENCODE_RETRY_BASE_DELAY_MS ?? 150);

class OpenCodeHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await Bun.sleep(ms);
}

export class OpenCodeClient {
  constructor(private readonly baseUrl: string) {}

  async send(req: AgentRequest): Promise<AgentResponse> {
    const retries = Number.isFinite(MAX_RETRIES) && MAX_RETRIES >= 0 ? Math.floor(MAX_RETRIES) : 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const aborter = new AbortController();
      const timeout = setTimeout(() => aborter.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const resp = await fetch(`${this.baseUrl}/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-client": "openpalm-gateway",
          },
          signal: aborter.signal,
          body: JSON.stringify({
            message: req.message,
            session_id: req.sessionId,
            user_id: req.userId,
            agent: req.agent,
            metadata: {
              ...req.metadata,
              channel: req.channel,
            },
          }),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new OpenCodeHttpError(
            `opencode ${resp.status}: ${body}`,
            shouldRetryStatus(resp.status),
          );
        }

        const data = (await resp.json()) as Record<string, unknown>;
        return {
          response: String(data.response ?? data.message ?? ""),
          sessionId: String(data.session_id ?? req.sessionId),
          agent: data.agent ? String(data.agent) : req.agent,
          metadata: (data.metadata as Record<string, unknown>) ?? {},
        };
      } catch (error) {
        const isAbort = error instanceof DOMException && error.name === "AbortError";
        const normalizedError = isAbort
          ? new Error(`opencode timeout after ${DEFAULT_TIMEOUT_MS}ms`)
          : error;
        lastError = normalizedError;

        const retryable = normalizedError instanceof OpenCodeHttpError
          ? normalizedError.retryable
          : true;

        if (attempt < retries && retryable) {
          await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw normalizedError;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("opencode request failed");
  }
}
