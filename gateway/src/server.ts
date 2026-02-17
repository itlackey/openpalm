import { randomUUID } from "node:crypto";
import { AuditLog } from "./audit.ts";
import { verifyReplayProtection, verifySignature } from "./channel-security.ts";
import { allowRequest } from "./rate-limit.ts";
import { OpenCodeClient } from "./opencode-client.ts";
import type { ChannelMessage, MessageRequest } from "./types.ts";

const PORT = Number(Bun.env.PORT ?? 8080);
const OPENCODE_BASE_URL = Bun.env.OPENCODE_BASE_URL ?? "http://opencode:4096";
const CHANNEL_SHARED_SECRETS: Record<string, string> = {
  chat: Bun.env.CHANNEL_CHAT_SECRET ?? "",
  discord: Bun.env.CHANNEL_DISCORD_SECRET ?? "",
  voice: Bun.env.CHANNEL_VOICE_SECRET ?? "",
  telegram: Bun.env.CHANNEL_TELEGRAM_SECRET ?? "",
};

const opencode = new OpenCodeClient(OPENCODE_BASE_URL);
const audit = new AuditLog("/app/data/audit.log");

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Forward a message to OpenCode for processing.
 * Channel requests use the "channel-intake" agent (restricted toolset).
 * Direct /message requests use the default agent.
 */
async function processMessage(
  body: Partial<MessageRequest>,
  requestId: string,
  channel?: string
) {
  const userId = body.userId ?? "default-user";
  const text = body.text?.trim();
  const sessionId = body.sessionId ?? randomUUID();
  if (!text) return json(400, { error: "text is required", requestId });

  const rlKey = `${userId}:${new Date().getUTCMinutes()}`;
  if (!allowRequest(rlKey, 120, 60_000))
    return json(429, { error: "rate_limited", requestId });

  // Assign specialized agent for channel requests; default agent for direct API
  const agent = channel ? "channel-intake" : undefined;

  try {
    const result = await opencode.send({
      message: text,
      userId,
      sessionId,
      agent,
      channel,
      metadata: body.metadata,
    });

    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId,
      action: "message",
      status: "ok",
      details: { channel, agent },
    });

    return json(200, {
      requestId,
      sessionId,
      userId,
      answer: result.response,
      agent: result.agent,
      metadata: result.metadata,
    });
  } catch (error) {
    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId,
      action: "message",
      status: "error",
      details: { channel, agent, error: String(error) },
    });
    return json(502, { error: "agent_unavailable", requestId });
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET")
        return json(200, {
          ok: true,
          service: "gateway",
          time: new Date().toISOString(),
        });

      if (url.pathname === "/message" && req.method === "POST")
        return processMessage(await req.json(), requestId);

      // Channel inbound — verify HMAC + replay, then forward to OpenCode
      if (url.pathname === "/channel/inbound" && req.method === "POST") {
        const raw = await req.text();
        const payload = JSON.parse(raw) as ChannelMessage;
        const incomingSig = req.headers.get("x-channel-signature") ?? "";
        const channelSecret = CHANNEL_SHARED_SECRETS[payload.channel] ?? "";

        if (!channelSecret)
          return json(403, { error: "channel_not_configured" });
        if (!verifySignature(channelSecret, raw, incomingSig))
          return json(403, { error: "invalid_signature" });
        if (
          !verifyReplayProtection(
            payload.channel,
            payload.nonce,
            payload.timestamp
          )
        )
          return json(409, { error: "replay_detected" });

        audit.write({
          ts: new Date().toISOString(),
          requestId,
          action: "channel_inbound",
          status: "ok",
          details: { channel: payload.channel, userId: payload.userId },
        });

        return processMessage(
          {
            userId: payload.userId,
            text: payload.text,
            metadata: payload.metadata,
          },
          requestId,
          payload.channel
        );
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      audit.write({
        ts: new Date().toISOString(),
        requestId,
        action: "server",
        status: "error",
        details: { error: String(error) },
      });
      return json(500, { error: "internal_error" });
    }
  },
});

console.log(JSON.stringify({ kind: "startup", port: server.port }));
