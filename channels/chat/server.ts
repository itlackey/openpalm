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

import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const logger = createLogger("channel-chat");

const PORT = Number(Bun.env.PORT ?? 8181);
const GUARDIAN_URL = Bun.env.GUARDIAN_URL ?? "http://guardian:8080";
const SHARED_SECRET = Bun.env.CHANNEL_CHAT_SECRET ?? "";
const API_KEY = Bun.env.OPENAI_COMPAT_API_KEY ?? "";

// ── Helpers ─────────────────────────────────────────────────────────────

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

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

// ── Forward to guardian ──────────────────────────────────────────────────

async function forward(text: string, userId: string): Promise<{ answer: string; sessionId: string }> {
  const payload = buildChannelMessage({ userId, channel: "chat", text, metadata: {} });
  const resp = await forwardChannelMessage(GUARDIAN_URL, SHARED_SECRET, payload);
  if (!resp.ok) throw new Error(`Guardian ${resp.status}`);
  const data = await resp.json() as Record<string, unknown>;
  return { answer: String(data.answer ?? ""), sessionId: String(data.sessionId ?? "") };
}

// ── Startup ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (!SHARED_SECRET) {
    logger.error("CHANNEL_CHAT_SECRET is not set, exiting");
    process.exit(1);
  }

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") return json(200, { ok: true, service: "channel-chat" });

      const isChatCompletions = url.pathname === "/v1/chat/completions" && req.method === "POST";
      const isCompletions = url.pathname === "/v1/completions" && req.method === "POST";
      const isAnthropicMsg = url.pathname === "/v1/messages" && req.method === "POST";

      if (!isChatCompletions && !isCompletions && !isAnthropicMsg) return json(404, { error: "not_found" });

      // Auth check
      if ((isChatCompletions || isCompletions) && API_KEY) {
        if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) return json(401, { error: { message: "Unauthorized" } });
      }

      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json(400, { error: { message: "Invalid JSON" } }); }

      if (body.stream === true) return json(400, { error: { message: "Streaming is not supported" } });

      const text = isChatCompletions || isAnthropicMsg
        ? extractChatText(body.messages)
        : typeof body.prompt === "string" ? body.prompt : null;

      if (!text) return json(400, { error: { message: "No user message found" } });

      const model = typeof body.model === "string" ? body.model : "openpalm";
      const userId = typeof body.user === "string" ? body.user : "api-user";

      try {
        const { answer } = await forward(text, userId);
        const created = Math.floor(Date.now() / 1000);

        if (isChatCompletions) {
          return json(200, {
            id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created, model,
            choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }

        if (isAnthropicMsg) {
          return json(200, {
            id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant",
            content: [{ type: "text", text: answer }], model, stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 },
          });
        }

        return json(200, {
          id: `cmpl-${crypto.randomUUID()}`, object: "text_completion", created, model,
          choices: [{ text: answer, index: 0, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (err) {
        return json(502, { error: { message: `Guardian error: ${err}` } });
      }
    },
  });

  logger.info("started", { port: PORT });
}
