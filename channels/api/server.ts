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

import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const logger = createLogger("channel-api");

const PORT = Number(Bun.env.PORT ?? 8186);
const GUARDIAN_URL = Bun.env.GUARDIAN_URL ?? "http://guardian:8080";
const SHARED_SECRET = Bun.env.CHANNEL_API_SECRET ?? "";
const API_KEY = Bun.env.OPENAI_COMPAT_API_KEY ?? "";

// ── Helpers ──────────────────────────────────────────────────────────────

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

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

// ── Fetch handler (exported for testing) ─────────────────────────────────

export function createApiFetch(
  gatewayUrl: string,
  sharedSecret: string,
  apiKey: string,
  forwardFetch: typeof fetch = fetch,
) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-api" });

    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return json(404, openAIError("Not found"));
    }

    if (apiKey) {
      if (req.headers.get("authorization") !== `Bearer ${apiKey}`) {
        return json(401, openAIError("Unauthorized"));
      }
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(400, openAIError("Invalid JSON")); }

    if (body.stream === true) return json(400, openAIError("Streaming is not supported"));

    const text = extractChatText(body.messages);
    if (!text) return json(400, openAIError("messages with user content is required"));

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

    const payload = buildChannelMessage({ userId, channel: "api", text, metadata: { model } });
    let guardianResp: Response;
    try {
      guardianResp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);
    } catch (err) {
      return json(502, openAIError(`Guardian error: ${err}`));
    }

    if (!guardianResp.ok) {
      const status = guardianResp.status >= 500 ? 502 : guardianResp.status;
      return json(status, openAIError(`Guardian error (${guardianResp.status})`));
    }

    const data = await guardianResp.json() as Record<string, unknown>;
    const answer = typeof data.answer === "string" ? data.answer : "";
    const created = Math.floor(Date.now() / 1000);

    return json(200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  };
}

// ── Startup ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (!SHARED_SECRET) {
    logger.error("CHANNEL_API_SECRET is not set, exiting");
    process.exit(1);
  }
  Bun.serve({ port: PORT, fetch: createApiFetch(GUARDIAN_URL, SHARED_SECRET, API_KEY) });
  logger.info("started", { port: PORT });
}
