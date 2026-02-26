type AgentRequest = {
  message: string;
  userId: string;
  sessionId: string;
  agent?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
};

type AgentResponse = {
  response: string;
  sessionId: string;
  agent?: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 15_000);
const MAX_RETRIES = Number(Bun.env.OPENCODE_RETRIES ?? 2);
const RETRY_BASE_DELAY_MS = Number(Bun.env.OPENCODE_RETRY_BASE_DELAY_MS ?? 150);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

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
          headers: { "content-type": "application/json", "x-client": "openpalm-gateway" },
          signal: aborter.signal,
          body: JSON.stringify({
            message: req.message, session_id: req.sessionId, user_id: req.userId,
            agent: req.agent, metadata: { ...req.metadata, channel: req.channel },
          }),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          const err = new Error(`opencode ${resp.status}: ${body}`);
          if (attempt < retries && RETRY_STATUS.has(resp.status)) {
            lastError = err;
            await Bun.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          throw err;
        }

        const data = (await resp.json()) as Record<string, unknown>;
        return {
          response: String(data.response ?? data.message ?? ""),
          sessionId: String(data.session_id ?? req.sessionId),
          agent: data.agent ? String(data.agent) : req.agent,
          metadata: (data.metadata as Record<string, unknown>) ?? {},
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new Error(`opencode timeout after ${DEFAULT_TIMEOUT_MS}ms`);
        } else {
          lastError = error;
        }
        if (attempt < retries && !(error instanceof Error && error.message.startsWith("opencode "))) {
          await Bun.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("opencode request failed");
  }
}
