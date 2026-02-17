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

export class OpenCodeClient {
  constructor(private readonly baseUrl: string) {}

  async send(req: AgentRequest): Promise<AgentResponse> {
    const resp = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      throw new Error(`opencode ${resp.status}: ${body}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return {
      response: String(data.response ?? data.message ?? ""),
      sessionId: String(data.session_id ?? req.sessionId),
      agent: data.agent ? String(data.agent) : req.agent,
      metadata: (data.metadata as Record<string, unknown>) ?? {},
    };
  }
}
