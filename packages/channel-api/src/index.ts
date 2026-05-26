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

import { BaseChannel, constantTimeEqual, asRecord, extractChatText } from "@openpalm/channels-sdk";

// ── Error helpers ────────────────────────────────────────────────────────

type ErrorFormatter = (message: string, type?: string) => Record<string, unknown>;

function openAIError(message: string, type = "invalid_request_error") {
  return { error: { message, type } };
}

function anthropicError(message: string, type = "invalid_request_error") {
  return { type: "error", error: { type, message } };
}

/**
 * Map an error thrown by `forwardToGuardian` into a per-protocol error
 * Response. The SDK throws on guardian failure; we translate the message
 * into the right shape (OpenAI vs Anthropic) so callers don't have to.
 */
function guardianErrorResponse(
  err: unknown,
  formatError: ErrorFormatter,
  jsonResp: (status: number, data: unknown) => Response,
): Response {
  const message = err instanceof Error ? err.message : String(err);
  // The SDK error format is: `Guardian returned status <N>` for HTTP errors,
  // and arbitrary network messages for transport failures. Both should map
  // to 502 — the upstream service is unreachable / misbehaving from the
  // client's point of view.
  const statusMatch = message.match(/Guardian returned status (\d+)/);
  const upstreamStatus = statusMatch ? Number(statusMatch[1]) : NaN;
  const status = Number.isFinite(upstreamStatus) && upstreamStatus < 500 ? upstreamStatus : 502;
  return jsonResp(status, formatError(`Guardian error: ${message}`));
}

// ── Channel ──────────────────────────────────────────────────────────────

export default class ApiChannel extends BaseChannel {
  name = Bun.env.CHANNEL_ID ?? "api";

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
    return constantTimeEqual(token, this.apiKey);
  }

  /** Validate Anthropic-style x-api-key auth. Returns true if authorized. */
  private checkAnthropicAuth(req: Request): boolean {
    if (!this.apiKey) return true;
    const apiKey = req.headers.get("x-api-key")?.trim();
    if (!apiKey) return false;
    return constantTimeEqual(apiKey, this.apiKey);
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
    const rawUser = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";
    const userId = `${this.name}:${rawUser}`;

    let answer: string;
    try {
      const guardResp = await this.forward({ userId, text, metadata: { model } });
      if (!guardResp.ok) throw new Error(`Guardian returned status ${guardResp.status}`);
      const data = await guardResp.json() as { answer?: string };
      answer = data.answer ?? "";
    } catch (err) {
      this.log("error", "guardian_error", { requestId, error: err instanceof Error ? err.message : String(err) });
      return guardianErrorResponse(err, openAIError, (s, d) => this.json(s, d));
    }

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
    const rawUser = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";
    const userId = `${this.name}:${rawUser}`;

    let answer: string;
    try {
      const guardResp = await this.forward({ userId, text, metadata: { model } });
      if (!guardResp.ok) throw new Error(`Guardian returned status ${guardResp.status}`);
      const data = await guardResp.json() as { answer?: string };
      answer = data.answer ?? "";
    } catch (err) {
      this.log("error", "guardian_error", { requestId, error: err instanceof Error ? err.message : String(err) });
      return guardianErrorResponse(err, openAIError, (s, d) => this.json(s, d));
    }

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
    const rawUser = (meta && typeof meta.user_id === "string" && meta.user_id.trim())
      ? meta.user_id
      : "api-user";
    const userId = `${this.name}:${rawUser}`;

    let answer: string;
    try {
      const guardResp = await this.forward({ userId, text, metadata: { model } });
      if (!guardResp.ok) throw new Error(`Guardian returned status ${guardResp.status}`);
      const data = await guardResp.json() as { answer?: string };
      answer = data.answer ?? "";
    } catch (err) {
      this.log("error", "guardian_error", { requestId, error: err instanceof Error ? err.message : String(err) });
      return guardianErrorResponse(err, anthropicError, (s, d) => this.json(s, d));
    }

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
}
