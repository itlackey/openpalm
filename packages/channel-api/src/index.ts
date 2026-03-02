/**
 * OpenPalm Channel API — OpenAI chat completions endpoint.
 *
 * Translates POST /v1/chat/completions requests into signed channel messages
 * and forwards them to the guardian.
 *
 * Endpoints:
 *   POST /v1/chat/completions
 *   GET  /health
 */

import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

// ── Helpers ──────────────────────────────────────────────────────────────

function openAIError(message: string) {
  return { error: { message, type: "invalid_request_error" } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractChatText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = asRecord(messages[i]);
    if (!record || record.role !== "user") continue;
    if (typeof record.content === "string" && record.content.trim()) return record.content;
    if (Array.isArray(record.content)) {
      const parts: string[] = [];
      for (const part of record.content) {
        const p = asRecord(part);
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) parts.push(p.text);
      }
      if (parts.length) return parts.join("\n");
    }
  }
  return null;
}

// ── Channel ──────────────────────────────────────────────────────────────

export default class ApiChannel extends BaseChannel {
  name = "api";

  /** API key for Bearer auth. Empty = no auth required. */
  get apiKey(): string {
    return Bun.env.OPENAI_COMPAT_API_KEY ?? "";
  }

  async route(req: Request, url: URL): Promise<Response | null> {
    // Health endpoint handled by base class (falls through when we return null)
    if (url.pathname === "/health") return null;

    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return this.json(404, openAIError("Not found"));
    }

    // Auth check
    if (this.apiKey) {
      if (req.headers.get("authorization") !== `Bearer ${this.apiKey}`) {
        return this.json(401, openAIError("Unauthorized"));
      }
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return this.json(400, openAIError("Invalid JSON")); }

    if (body.stream === true) return this.json(400, openAIError("Streaming is not supported"));

    const text = extractChatText(body.messages);
    if (!text) return this.json(400, openAIError("messages with user content is required"));

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

    // Forward to guardian using BaseChannel's forward method
    let guardianResp: Response;
    try {
      guardianResp = await this.forward({ userId, text, metadata: { model } });
    } catch (err) {
      return this.json(502, openAIError(`Guardian error: ${err}`));
    }

    if (!guardianResp.ok) {
      const status = guardianResp.status >= 500 ? 502 : guardianResp.status;
      return this.json(status, openAIError(`Guardian error (${guardianResp.status})`));
    }

    const data = await guardianResp.json() as Record<string, unknown>;
    const answer = typeof data.answer === "string" ? data.answer : "";
    const created = Math.floor(Date.now() / 1000);

    return this.json(200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // handleRequest is not used — all logic is in route()
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }
}
