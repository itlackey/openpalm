import { randomUUID } from "node:crypto";
import { json } from "@openpalm/lib/shared/http.ts";
import { AuditLog } from "./audit.ts";
import { buildIntakeCommand, parseIntakeDecision } from "./channel-intake.ts";
import { verifySignature } from "./channel-security.ts";
import { allowRequest } from "./rate-limit.ts";
import { OpenCodeClient } from "./assistant-client.ts";
import type { ChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { safeRequestId, validatePayload } from "./server-utils.ts";

export type GatewayDeps = {
  channelSecrets: Record<string, string>;
  openCode: OpenCodeClient;
  audit: AuditLog;
};

export function createGatewayFetch(deps: GatewayDeps): (req: Request) => Promise<Response> {
  const { channelSecrets, openCode, audit } = deps;

  async function processChannelInbound(payload: ChannelMessage, requestId: string) {
    const sessionId = randomUUID();

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

  return async function fetch(req: Request): Promise<Response> {
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

        const channelName = typeof payload.channel === "string" ? payload.channel : "";
        const channelSecret = channelSecrets[channelName] ?? "";

        if (!channelSecret)
          return json(403, { error: "channel_not_configured", requestId });

        if (!verifySignature(channelSecret, raw, incomingSig))
          return json(403, { error: "invalid_signature", requestId });

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
  };
}

if (import.meta.main) {
  const PORT = Number(Bun.env.PORT ?? 8080);
  const OPENCODE_CORE_BASE_URL = Bun.env.OPENCODE_CORE_BASE_URL ?? "http://assistant:4096";

  const CHANNEL_SHARED_SECRETS: Record<string, string> = {
    chat: Bun.env.CHANNEL_CHAT_SECRET ?? "",
    discord: Bun.env.CHANNEL_DISCORD_SECRET ?? "",
    voice: Bun.env.CHANNEL_VOICE_SECRET ?? "",
    telegram: Bun.env.CHANNEL_TELEGRAM_SECRET ?? "",
  };

  const openCode = new OpenCodeClient(OPENCODE_CORE_BASE_URL);
  const audit = new AuditLog("/app/data/audit.log");

  const server = Bun.serve({
    port: PORT,
    fetch: createGatewayFetch({ channelSecrets: CHANNEL_SHARED_SECRETS, openCode, audit }),
  });

  console.log(JSON.stringify({ kind: "startup", port: server.port }));
}
