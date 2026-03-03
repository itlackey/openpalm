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

/** Constant-time string comparison (XOR loop, same pattern as channels-sdk crypto.ts). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return false;
    const match = authHeader.trim().match(/^Bearer\s+(\S+)\s*$/i);
    const token = match?.[1] ?? "";
    if (!token) return false;
    return safeEqual(token, this.apiKey);
  }

  /** Validate Anthropic-style x-api-key auth. Returns true if authorized. */
  private checkAnthropicAuth(req: Request): boolean {
    if (!this.apiKey) return true;
    const apiKey = req.headers.get("x-api-key")?.trim();
    if (!apiKey) return false;
    return safeEqual(apiKey, this.apiKey);
  }

  // ── Routing ──────────────────────────────────────────────────────────

  async route(req: Request, url: URL): Promise<Response | null> {
    const requestId = crypto.randomUUID();

    // Models listing — no auth required, useful for client discovery
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return this.handleModels();
    }

    // OpenAI: POST /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return this.handleChatCompletions(req, requestId);
    }

    // OpenAI: POST /v1/completions
    if (url.pathname === "/v1/completions" && req.method === "POST") {
      return this.handleCompletions(req, requestId);
    }

    // Anthropic: POST /v1/messages
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      return this.handleAnthropicMessages(req, requestId);
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

  private async handleChatCompletions(req: Request, requestId: string): Promise<Response> {
    if (!this.checkOpenAIAuth(req)) {
      this.log("warn", "auth_failure", { requestId, path: "/v1/chat/completions" });
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

    const answer = await this.forwardToGuardian(userId, text, { model }, openAIError, requestId);
    if (answer instanceof Response) return answer;

    this.log("info", "request_forwarded", { requestId, userId, path: "/v1/chat/completions" });
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

  private async handleCompletions(req: Request, requestId: string): Promise<Response> {
    if (!this.checkOpenAIAuth(req)) {
      this.log("warn", "auth_failure", { requestId, path: "/v1/completions" });
      return this.json(401, openAIError("Unauthorized", "authentication_error"));
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return this.json(400, openAIError("Invalid JSON")); }

    if (body.stream === true) {
      return this.json(400, openAIError("Streaming is not supported"));
    }

    const prompt = body.prompt;
    let text: string | null = null;
    if (typeof prompt === "string" && prompt.trim()) {
      text = prompt;
    } else if (Array.isArray(prompt)) {
      const parts = prompt.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
      if (parts.length === prompt.length) {
        const joined = parts.map((p) => String(p)).join(" ");
        text = joined.trim() ? joined : null;
      }
    }
    if (!text) return this.json(400, openAIError("prompt is required"));

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

    const answer = await this.forwardToGuardian(userId, text, { model }, openAIError, requestId);
    if (answer instanceof Response) return answer;

    this.log("info", "request_forwarded", { requestId, userId, path: "/v1/completions" });
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

  private async handleAnthropicMessages(req: Request, requestId: string): Promise<Response> {
    if (!this.checkAnthropicAuth(req)) {
      this.log("warn", "auth_failure", { requestId, path: "/v1/messages" });
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

    const answer = await this.forwardToGuardian(userId, text, { model }, anthropicError, requestId);
    if (answer instanceof Response) return answer;

    this.log("info", "request_forwarded", { requestId, userId, path: "/v1/messages" });
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
    formatError: (message: string, type?: string) => Record<string, unknown> = openAIError,
    requestId?: string,
  ): Promise<string | Response> {
    let guardianResp: Response;
    try {
      guardianResp = await this.forward({ userId, text, metadata });
    } catch (err) {
      this.log("error", "guardian_fetch_failed", { requestId, error: String(err) });
      return this.json(502, formatError("Guardian unavailable"));
    }

    if (!guardianResp.ok) {
      const status = guardianResp.status >= 500 ? 502 : guardianResp.status;
      this.log("error", "guardian_error", { requestId, status: guardianResp.status });
      return this.json(status, formatError(`Guardian error (${guardianResp.status})`));
    }

    let data: Record<string, unknown>;
    try {
      data = await guardianResp.json() as Record<string, unknown>;
    } catch {
      this.log("error", "guardian_invalid_json", { requestId });
      return this.json(502, formatError("Guardian returned invalid JSON"));
    }
    return typeof data.answer === "string" ? data.answer : "";
  }

  // handleRequest is not used — all logic is in route()
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }
}
