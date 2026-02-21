import { randomUUID } from "node:crypto";
import { AuditLog } from "./audit.ts";
import { buildIntakeCommand, parseIntakeDecision } from "./channel-intake.ts";
import { verifySignature } from "./channel-security.ts";
import { allowRequest } from "./rate-limit.ts";
import { OpenCodeClient } from "./assistant-client.ts";
import type { ChannelMessage } from "./types.ts";

const PORT = Number(Bun.env.PORT ?? 8080);
const OPENCODE_CORE_BASE_URL = Bun.env.OPENCODE_CORE_BASE_URL ?? "http://assistant:4096";
const ALLOWED_CHANNELS = new Set(["chat", "discord", "voice", "telegram"]);

const CHANNEL_SHARED_SECRETS: Record<string, string> = {
  chat: Bun.env.CHANNEL_CHAT_SECRET ?? "",
  discord: Bun.env.CHANNEL_DISCORD_SECRET ?? "",
  voice: Bun.env.CHANNEL_VOICE_SECRET ?? "",
  telegram: Bun.env.CHANNEL_TELEGRAM_SECRET ?? "",
};

const openCode = new OpenCodeClient(OPENCODE_CORE_BASE_URL);
const audit = new AuditLog("/app/data/audit.log");

function safeRequestId(header: string | null): string {
  if (header && /^[a-zA-Z0-9_-]{1,64}$/.test(header)) return header;
  return randomUUID();
}

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validatePayload(payload: Partial<ChannelMessage>): payload is ChannelMessage {
  return (
    typeof payload.userId === "string" &&
    payload.userId.trim().length > 0 &&
    typeof payload.channel === "string" &&
    ALLOWED_CHANNELS.has(payload.channel) &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0 &&
    payload.text.length <= 10_000 &&
    typeof payload.nonce === "string" &&
    payload.nonce.trim().length > 0 &&
    typeof payload.timestamp === "number"
  );
}

async function processChannelInbound(payload: ChannelMessage, requestId: string) {
  const sessionId = randomUUID();

  // Rate-limit check FIRST (pipeline step 3 before audit step 6).
  const rlKey = payload.userId;
  if (!allowRequest(rlKey, 120, 60_000)) {
    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId: payload.userId,
      action: "channel_inbound",
      status: "denied",
      details: { channel: payload.channel, reason: "rate_limited" },
    });
    return json(429, { error: "rate_limited", requestId });
  }

  // Initial audit entry written only for requests that pass rate limiting.
  audit.write({
    ts: new Date().toISOString(),
    requestId,
    sessionId,
    userId: payload.userId,
    action: "channel_inbound",
    status: "ok",
    details: { channel: payload.channel },
  });

  let intake;
  try {
    const intakeResult = await openCode.send({
      message: buildIntakeCommand(payload),
      userId: payload.userId,
      sessionId,
      agent: "channel-intake",
      channel: payload.channel,
      metadata: payload.metadata,
    });
    intake = parseIntakeDecision(intakeResult.response);
  } catch (error) {
    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId: payload.userId,
      action: "channel_intake",
      status: "error",
      details: { channel: payload.channel, error: String(error) },
    });
    return json(502, { error: "channel_intake_unavailable", requestId });
  }

  if (!intake.valid) {
    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId: payload.userId,
      action: "channel_intake",
      status: "denied",
      details: { channel: payload.channel, reason: intake.reason || "rejected" },
    });
    return json(422, {
      error: "invalid_channel_request",
      reason: intake.reason || "rejected",
      requestId,
    });
  }

  try {
    const coreResult = await openCode.send({
      message: intake.summary,
      userId: payload.userId,
      sessionId,
      channel: payload.channel,
      metadata: {
        ...payload.metadata,
        intakeSummary: intake.summary,
        intakeValid: true,
      },
    });

    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId: payload.userId,
      action: "channel_forward_to_core",
      status: "ok",
      details: { channel: payload.channel },
    });

    return json(200, {
      requestId,
      sessionId,
      userId: payload.userId,
      answer: coreResult.response,
      intake: {
        valid: true,
        summary: intake.summary,
      },
      metadata: coreResult.metadata,
    });
  } catch (error) {
    audit.write({
      ts: new Date().toISOString(),
      requestId,
      sessionId,
      userId: payload.userId,
      action: "channel_forward_to_core",
      status: "error",
      details: { channel: payload.channel, error: String(error) },
    });
    return json(502, { error: "core_runtime_unavailable", requestId });
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const requestId = safeRequestId(req.headers.get("x-request-id"));
    try {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET")
        return json(200, {
          ok: true,
          service: "gateway",
          time: new Date().toISOString(),
        });

      if (url.pathname === "/channel/inbound" && req.method === "POST") {
        const raw = await req.text();
        const payload = JSON.parse(raw) as Partial<ChannelMessage>;
        const incomingSig = req.headers.get("x-channel-signature") ?? "";

        // Issue 1 fix: HMAC verification happens BEFORE full payload validation.
        // Step 1: extract channel from the parsed (but not yet fully validated) payload.
        const channelName = typeof payload.channel === "string" ? payload.channel : "";
        const channelSecret = CHANNEL_SHARED_SECRETS[channelName] ?? "";

        // Step 2: reject unknown / unconfigured channels before checking signature.
        if (!channelSecret)
          return json(403, { error: "channel_not_configured", requestId });

        // Step 3: verify HMAC signature first.
        if (!verifySignature(channelSecret, raw, incomingSig))
          return json(403, { error: "invalid_signature", requestId });

        // Step 4: now run full structural payload validation.
        if (!validatePayload(payload))
          return json(400, { error: "invalid_payload", requestId });

        return processChannelInbound(payload, requestId);
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
      return json(500, { error: "internal_error", requestId });
    }
  },
});

console.log(JSON.stringify({ kind: "startup", port: server.port }));
