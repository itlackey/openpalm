/**
 * OpenPalm Channel API — OpenAI & Anthropic compatible adapter.
 *
 * Acts as a facade/adapter layer so any tool compatible with the OpenAI or
 * Anthropic API can point at an instance of this channel and work transparently.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — OpenAI chat completions
 *   POST /v1/completions        — OpenAI legacy completions
 *   POST /v1/messages           — Anthropic messages
 *   GET  /v1/models             — List available models
 *   GET  /health                — Health check
 */

import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

// ── Error helpers ────────────────────────────────────────────────────────

function openAIError(message: string, type = "invalid_request_error") {
  return { error: { message, type } };
}

function anthropicError(message: string, type = "invalid_request_error") {
  return { type: "error", error: { type, message } };
}

// ── Parsing helpers ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Extracts the last user message text from an OpenAI or Anthropic messages array.
 * Supports both plain string content and content-block arrays.
 */
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

  /** API key for Bearer / x-api-key auth. Empty = no auth required. */
  get apiKey(): string {
    return Bun.env.OPENAI_COMPAT_API_KEY ?? "";
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  /** Validate OpenAI-style Bearer auth. Returns true if authorized. */
  private checkOpenAIAuth(req: Request): boolean {
    if (!this.apiKey) return true;
    return req.headers.get("authorization") === `Bearer ${this.apiKey}`;
  }

  /** Validate Anthropic-style x-api-key auth. Returns true if authorized. */
  private checkAnthropicAuth(req: Request): boolean {
    if (!this.apiKey) return true;
    return req.headers.get("x-api-key") === this.apiKey;
  }

  // ── Routing ──────────────────────────────────────────────────────────

  async route(req: Request, url: URL): Promise<Response | null> {
    // Health endpoint handled by base class
    if (url.pathname === "/health") return null;

    // Models listing — no auth required, useful for client discovery
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return this.handleModels();
    }

    // OpenAI: POST /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return this.handleChatCompletions(req);
    }

    // OpenAI: POST /v1/completions
    if (url.pathname === "/v1/completions" && req.method === "POST") {
      return this.handleCompletions(req);
    }

    // Anthropic: POST /v1/messages
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      return this.handleAnthropicMessages(req);
    }

    return this.json(404, openAIError("Not found"));
  }

  // ── GET /v1/models ───────────────────────────────────────────────────

  private handleModels(): Response {
    const now = Math.floor(Date.now() / 1000);
    return this.json(200, {
      object: "list",
      data: [
        { id: "openpalm", object: "model", created: now, owned_by: "openpalm" },
      ],
    });
  }

  // ── POST /v1/chat/completions ────────────────────────────────────────

  private async handleChatCompletions(req: Request): Promise<Response> {
    if (!this.checkOpenAIAuth(req)) {
      return this.json(401, openAIError("Unauthorized", "authentication_error"));
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return this.json(400, openAIError("Invalid JSON")); }

    if (body.stream === true) {
      return this.json(400, openAIError("Streaming is not supported"));
    }

    const text = extractChatText(body.messages);
    if (!text) return this.json(400, openAIError("messages with user content is required"));

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

    const answer = await this.forwardToGuardian(userId, text, { model });
    if (answer instanceof Response) return answer; // error response

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

  // ── POST /v1/completions ─────────────────────────────────────────────

  private async handleCompletions(req: Request): Promise<Response> {
    if (!this.checkOpenAIAuth(req)) {
      return this.json(401, openAIError("Unauthorized", "authentication_error"));
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return this.json(400, openAIError("Invalid JSON")); }

    if (body.stream === true) {
      return this.json(400, openAIError("Streaming is not supported"));
    }

    const text = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : null;
    if (!text) return this.json(400, openAIError("prompt is required"));

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

    const answer = await this.forwardToGuardian(userId, text, { model });
    if (answer instanceof Response) return answer;

    const created = Math.floor(Date.now() / 1000);
    return this.json(200, {
      id: `cmpl-${crypto.randomUUID()}`,
      object: "text_completion",
      created,
      model,
      choices: [{ text: answer, index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // ── POST /v1/messages (Anthropic) ────────────────────────────────────

  private async handleAnthropicMessages(req: Request): Promise<Response> {
    if (!this.checkAnthropicAuth(req)) {
      return this.json(401, anthropicError("Unauthorized", "authentication_error"));
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return this.json(400, anthropicError("Invalid JSON")); }

    if (body.stream === true) {
      return this.json(400, anthropicError("Streaming is not supported"));
    }

    const text = extractChatText(body.messages);
    if (!text) return this.json(400, anthropicError("messages with user content is required"));

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    // Anthropic doesn't have a top-level `user` field; use metadata.user_id if present
    const meta = asRecord(body.metadata);
    const userId = (meta && typeof meta.user_id === "string" && meta.user_id.trim())
      ? meta.user_id
      : "api-user";

    const answer = await this.forwardToGuardian(userId, text, { model });
    if (answer instanceof Response) return answer;

    return this.json(200, {
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: answer }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  // ── Guardian forwarding ──────────────────────────────────────────────

  /**
   * Forward user text to the guardian and return the answer string,
   * or a pre-built error Response on failure.
   */
  private async forwardToGuardian(
    userId: string,
    text: string,
    metadata: Record<string, unknown>,
  ): Promise<string | Response> {
    let guardianResp: Response;
    try {
      guardianResp = await this.forward({ userId, text, metadata });
    } catch (err) {
      return this.json(502, openAIError(`Guardian error: ${err}`));
    }

    if (!guardianResp.ok) {
      const status = guardianResp.status >= 500 ? 502 : guardianResp.status;
      return this.json(status, openAIError(`Guardian error (${guardianResp.status})`));
    }

    const data = await guardianResp.json() as Record<string, unknown>;
    return typeof data.answer === "string" ? data.answer : "";
  }

  // handleRequest is not used — all logic is in route()
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }
}
