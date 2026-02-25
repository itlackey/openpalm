import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { json } from "@openpalm/lib/shared/http.ts";
import { AuditLog } from "./audit.ts";
import { buildIntakeCommand, parseIntakeDecision } from "./channel-intake.ts";
import { verifySignature } from "./channel-security.ts";
import { allowRequest } from "./rate-limit.ts";
import { nonceCache } from "./nonce-cache.ts";
import { OpenCodeClient } from "./assistant-client.ts";
import type { ChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { safeRequestId, validatePayload } from "./server-utils.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("gateway");
const MAX_SUMMARY_LENGTH = 2_000;
const CHANNEL_SECRET_PATTERN = /^CHANNEL_[A-Z0-9_]+_SECRET$/;

function sanitizeSummary(summary: string): string {
  let sanitized = summary.replace(/<\/?[^>]+(>|$)/g, "");
  if (sanitized.length > MAX_SUMMARY_LENGTH) {
    sanitized = sanitized.slice(0, MAX_SUMMARY_LENGTH);
  }
  return sanitized;
}

function parseEnvContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    values[key] = value;
  }
  return values;
}

function defaultSecretKeyForChannel(channelName: string): string {
  return `CHANNEL_${channelName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SECRET`;
}

export function discoverChannelSecretsFromState(stateRoot: string, fallbackEnv: Record<string, string | undefined> = Bun.env): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (!existsSync(stateRoot)) return secrets;

  for (const dirName of readdirSync(stateRoot)) {
    if (!dirName.startsWith("channel-")) continue;
    const channelName = dirName.slice("channel-".length);
    if (!channelName) continue;

    const envPath = join(stateRoot, dirName, ".env");
    if (!existsSync(envPath)) continue;

    const envValues = parseEnvContent(readFileSync(envPath, "utf8"));
    const defaultSecretKey = defaultSecretKeyForChannel(channelName);

    if (envValues[defaultSecretKey]) {
      secrets[channelName] = envValues[defaultSecretKey];
      continue;
    }

    const explicitSecretEntry = Object.entries(envValues).find(([key, value]) => CHANNEL_SECRET_PATTERN.test(key) && value);
    if (explicitSecretEntry?.[1]) {
      secrets[channelName] = explicitSecretEntry[1];
      continue;
    }

    const envFallback = fallbackEnv[defaultSecretKey];
    if (envFallback) secrets[channelName] = envFallback;
  }

  return secrets;
}

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
    if (!allowRequest(rlKey, 120, 60_000) || !allowRequest(`channel:${payload.channel}`, 200, 60_000)) {
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

    const sanitizedSummary = sanitizeSummary(intake.summary);

    try {
      const coreResult = await openCode.send({
        message: sanitizedSummary,
        userId: payload.userId,
        sessionId,
        channel: payload.channel,
        metadata: {
          ...payload.metadata,
          intakeSummary: sanitizedSummary,
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
          summary: sanitizedSummary,
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
        let payload: Partial<ChannelMessage>;
        try {
          payload = JSON.parse(raw) as Partial<ChannelMessage>;
        } catch {
          return json(400, { error: "invalid_json", requestId });
        }
        const incomingSig = req.headers.get("x-channel-signature") ?? "";

        const channelName = typeof payload.channel === "string" ? payload.channel : "";
        const channelSecret = channelSecrets[channelName] ?? "";

        if (!channelSecret)
          return json(403, { error: "channel_not_configured", requestId });

        if (!verifySignature(channelSecret, raw, incomingSig))
          return json(403, { error: "invalid_signature", requestId });

        if (!validatePayload(payload))
          return json(400, { error: "invalid_payload", requestId });

        if (!nonceCache.checkAndStore(payload.nonce, payload.timestamp))
          return json(409, { error: "replay_detected", requestId });

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
  const OPENPALM_ASSISTANT_URL = Bun.env.OPENPALM_ASSISTANT_URL ?? "http://assistant:4096";

  const CHANNEL_SHARED_SECRETS = discoverChannelSecretsFromState("/state", Bun.env);

  const openCode = new OpenCodeClient(OPENPALM_ASSISTANT_URL);
  const audit = new AuditLog("/app/data/audit.log");

  const server = Bun.serve({
    port: PORT,
    fetch: createGatewayFetch({ channelSecrets: CHANNEL_SHARED_SECRETS, openCode, audit }),
  });

  log.info("started", { port: server.port });
}
