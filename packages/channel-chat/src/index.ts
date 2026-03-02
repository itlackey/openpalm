/**
 * OpenPalm Channel Chat — OpenAI/Anthropic-compatible API endpoint.
 *
 * Translates standard chat/completion requests into signed channel messages
 * and forwards them to the guardian. Supports:
 *   - POST /v1/chat/completions (OpenAI format)
 *   - POST /v1/completions (OpenAI legacy)
 *   - POST /v1/messages (Anthropic format)
 *   - GET  /health
 */

import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

// ── Helpers ─────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function extractChatText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asRecord(messages[i]);
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string" && m.content.trim()) return m.content;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const p of m.content) {
        const part = asRecord(p);
        if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
      if (texts.length) return texts.join("\n");
    }
  }
  return null;
}

// ── Channel ──────────────────────────────────────────────────────────────

export default class ChatChannel extends BaseChannel {
  name = "chat";

  /** API key for Bearer auth. Empty = no auth required. */
  get apiKey(): string {
    return Bun.env.OPENAI_COMPAT_API_KEY ?? "";
  }

  async route(req: Request, url: URL): Promise<Response | null> {
    // Health endpoint handled by base class
    if (url.pathname === "/health") return null;

    const isChatCompletions = url.pathname === "/v1/chat/completions" && req.method === "POST";
    const isCompletions = url.pathname === "/v1/completions" && req.method === "POST";
    const isAnthropicMsg = url.pathname === "/v1/messages" && req.method === "POST";

    if (!isChatCompletions && !isCompletions && !isAnthropicMsg) {
      return this.json(404, { error: "not_found" });
    }

    // Auth check for OpenAI-format endpoints
    if ((isChatCompletions || isCompletions) && this.apiKey) {
      if (req.headers.get("authorization") !== `Bearer ${this.apiKey}`) {
        return this.json(401, { error: { message: "Unauthorized" } });
      }
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return this.json(400, { error: { message: "Invalid JSON" } }); }

    if (body.stream === true) return this.json(400, { error: { message: "Streaming is not supported" } });

    const text = isChatCompletions || isAnthropicMsg
      ? extractChatText(body.messages)
      : typeof body.prompt === "string" ? body.prompt : null;

    if (!text) return this.json(400, { error: { message: "No user message found" } });

    const model = typeof body.model === "string" ? body.model : "openpalm";
    const userId = typeof body.user === "string" ? body.user : "api-user";

    // Forward to guardian
    let guardianResp: Response;
    try {
      guardianResp = await this.forward({ userId, text, metadata: {} });
    } catch (err) {
      return this.json(502, { error: { message: `Guardian error: ${err}` } });
    }

    if (!guardianResp.ok) {
      return this.json(502, { error: { message: `Guardian ${guardianResp.status}` } });
    }

    const data = await guardianResp.json() as Record<string, unknown>;
    const answer = String(data.answer ?? "");
    const created = Math.floor(Date.now() / 1000);

    if (isChatCompletions) {
      return this.json(200, {
        id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    if (isAnthropicMsg) {
      return this.json(200, {
        id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant",
        content: [{ type: "text", text: answer }], model, stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }

    // Legacy completions
    return this.json(200, {
      id: `cmpl-${crypto.randomUUID()}`, object: "text_completion", created, model,
      choices: [{ text: answer, index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // handleRequest is not used — all logic is in route()
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }
}
