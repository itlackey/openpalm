/**
 * OpenPalm Guardian — Minimal message guardian for the MVP.
 *
 * Receives signed channel messages at POST /channel/inbound, validates
 * HMAC signature, checks for replay and rate limits, then forwards the
 * validated message to the assistant runtime for processing.
 *
 * Security pipeline:
 *   1. Parse JSON body
 *   2. Look up channel secret from environment variables
 *   3. Verify HMAC-SHA256 signature (x-channel-signature header)
 *   4. Reject replayed nonces (5-minute window)
 *   5. Rate limit per-user (120 req/min) and per-channel (200 req/min)
 *   6. Forward to assistant and return response
 */

import { ERROR_CODES, validatePayload } from "@openpalm/channels-sdk/channel";
import { verifySignature } from "@openpalm/channels-sdk/crypto";
import { createLogger } from "@openpalm/channels-sdk/logger";

import { loadChannelSecrets } from "./signature";
import { checkNonce, nonceCacheSize, NONCE_WINDOW_MS, NONCE_MAX_SIZE } from "./replay";
import {
  allow,
  activeRateLimiters,
  USER_RATE_LIMIT,
  USER_RATE_WINDOW_MS,
  CHANNEL_RATE_LIMIT,
  CHANNEL_RATE_WINDOW_MS,
} from "./rate-limit";
import {
  askAssistant,
  clearAssistantSessions,
  resolveSessionTarget,
  shouldClearSession,
  sessionCacheSize,
  SESSION_TTL_MS,
} from "./forward";
import { audit } from "./audit";

const logger = createLogger("guardian");

// ── Config ──────────────────────────────────────────────────────────────

const PORT = Number(Bun.env.PORT ?? 8080);

// ── Uptime & request counters ───────────────────────────────────────────

const startTime = Date.now();
const requestCounters = {
  total: 0,
  byStatus: new Map<string, number>(),
  byChannel: new Map<string, number>(),
};

function countRequest(status: string, channel?: string) {
  requestCounters.total++;
  requestCounters.byStatus.set(status, (requestCounters.byStatus.get(status) ?? 0) + 1);
  if (channel) {
    requestCounters.byChannel.set(channel, (requestCounters.byChannel.get(channel) ?? 0) + 1);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const rid = req.headers.get("x-request-id") ?? crypto.randomUUID();

    if (url.pathname === "/health" && req.method === "GET") {
      return json(200, { ok: true, service: "guardian", time: new Date().toISOString() });
    }

    if (url.pathname === "/stats" && req.method === "GET") {
      // No auth: guardian is on internal Docker networks only and stats
      // contain only operational counters (no secrets). Admin-tools and
      // stack-diagnostics call this endpoint from within the compose network.
      const { activeUserLimiters, activeChannelLimiters } = activeRateLimiters();

      return json(200, {
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        rate_limits: {
          user_window_ms: USER_RATE_WINDOW_MS,
          user_max_requests: USER_RATE_LIMIT,
          channel_window_ms: CHANNEL_RATE_WINDOW_MS,
          channel_max_requests: CHANNEL_RATE_LIMIT,
          active_user_limiters: activeUserLimiters,
          active_channel_limiters: activeChannelLimiters,
        },
        nonce_cache: {
          size: nonceCacheSize(),
          max_size: NONCE_MAX_SIZE,
          window_ms: NONCE_WINDOW_MS,
        },
        sessions: {
          active: sessionCacheSize(),
          max_size: 10_000,
          ttl_ms: SESSION_TTL_MS,
        },
        requests: {
          total: requestCounters.total,
          by_status: Object.fromEntries(requestCounters.byStatus),
          by_channel: Object.fromEntries(requestCounters.byChannel),
        },
      });
    }

    if (url.pathname === "/channel/inbound" && req.method === "POST") {
      // H8: Request body size limit (100KB)
      const contentLength = req.headers.get("content-length");
      if (contentLength && Number(contentLength) > 102_400) {
        countRequest(ERROR_CODES.PAYLOAD_TOO_LARGE);
        logger.warn("payload_too_large", { requestId: rid, contentLength: Number(contentLength) });
        return json(413, { error: ERROR_CODES.PAYLOAD_TOO_LARGE, requestId: rid });
      }

      const raw = await req.text();

      if (raw.length > 102_400) {
        countRequest(ERROR_CODES.PAYLOAD_TOO_LARGE);
        logger.warn("payload_too_large", { requestId: rid, bodyLength: raw.length });
        return json(413, { error: ERROR_CODES.PAYLOAD_TOO_LARGE, requestId: rid });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        countRequest(ERROR_CODES.INVALID_JSON);
        logger.debug("invalid_json", { requestId: rid });
        return json(400, { error: ERROR_CODES.INVALID_JSON, requestId: rid });
      }

      const validation = validatePayload(parsed);
      if (!validation.ok) {
        countRequest(validation.error);
        logger.debug("invalid_payload", { requestId: rid, reason: validation.error });
        return json(400, { error: validation.error, requestId: rid });
      }
      const payload = validation.payload;

      // C1: Use dummy secret for unknown channels to prevent channel name enumeration.
      // Both unknown channels and bad signatures return invalid_signature.
      const channelSecrets = await loadChannelSecrets();
      // Normalize channel name: SDK uses this.name (may contain hyphens like "my-channel"),
      // but env vars use underscores (CHANNEL_MY_CHANNEL_SECRET → key "my_channel").
      const secret = channelSecrets[payload.channel.toLowerCase().replace(/-/g, "_")] ?? "";

      const sig = req.headers.get("x-channel-signature") ?? "";
      // Always run HMAC verification (even for unknown channels) to prevent timing side-channel.
      // Use dummy secret for unknown channels, but reject afterward regardless of HMAC result.
      if (!secret) {
        verifySignature("dummy-secret-for-timing-parity", raw, sig);
        countRequest(ERROR_CODES.INVALID_SIGNATURE, payload.channel);
        logger.warn("unknown_channel", { requestId: rid, channel: payload.channel });
        return json(403, { error: ERROR_CODES.INVALID_SIGNATURE, requestId: rid });
      }
      if (!verifySignature(secret, raw, sig)) {
        countRequest(ERROR_CODES.INVALID_SIGNATURE, payload.channel);
        logger.warn("invalid_signature", { requestId: rid, channel: payload.channel, userId: payload.userId });
        return json(403, { error: ERROR_CODES.INVALID_SIGNATURE, requestId: rid });
      }

      // H3: Rate limit before nonce check to prevent nonce consumption for rate-limited requests
      if (!allow(payload.userId, USER_RATE_LIMIT, USER_RATE_WINDOW_MS) || !allow(`ch:${payload.channel}`, CHANNEL_RATE_LIMIT, CHANNEL_RATE_WINDOW_MS)) {
        countRequest(ERROR_CODES.RATE_LIMITED, payload.channel);
        audit({ requestId: rid, action: "inbound", status: "denied", reason: ERROR_CODES.RATE_LIMITED, channel: payload.channel });
        logger.warn("rate_limited", { requestId: rid, channel: payload.channel, userId: payload.userId });
        return json(429, { error: ERROR_CODES.RATE_LIMITED, requestId: rid });
      }

      if (!checkNonce(payload.nonce, payload.timestamp)) {
        countRequest(ERROR_CODES.REPLAY_DETECTED, payload.channel);
        logger.warn("replay_detected", { requestId: rid, channel: payload.channel, userId: payload.userId, nonce: payload.nonce });
        return json(409, { error: ERROR_CODES.REPLAY_DETECTED, requestId: rid });
      }

      const sessionTarget = resolveSessionTarget(payload.userId, payload.channel, payload.metadata);

      if (shouldClearSession(payload.metadata)) {
        try {
          await clearAssistantSessions(sessionTarget);
        } catch (err) {
          countRequest(ERROR_CODES.ASSISTANT_UNAVAILABLE, payload.channel);
          audit({ requestId: rid, action: "clear_session", status: "error", error: String(err) });
          logger.error("clear_session failed", { error: String(err), channel: payload.channel, userId: payload.userId, requestId: rid });
          return json(502, { error: ERROR_CODES.ASSISTANT_UNAVAILABLE, requestId: rid });
        }
        audit({
          requestId: rid,
          action: "clear_session",
          status: "ok",
          channel: payload.channel,
          userId: payload.userId,
          sessionKey: sessionTarget.sessionKey,
        });
        logger.info("session_cleared", { requestId: rid, channel: payload.channel, userId: payload.userId, sessionKey: sessionTarget.sessionKey });
        return json(200, {
          requestId: rid,
          cleared: true,
          userId: payload.userId,
        });
      }

      try {
        const { answer, sessionId } = await askAssistant(payload.text, sessionTarget);
        countRequest("ok", payload.channel);
        audit({
          requestId: rid,
          sessionId,
          action: "inbound",
          status: "ok",
          channel: payload.channel,
          userId: payload.userId,
          sessionKey: sessionTarget.sessionKey,
        });
        logger.info("forwarded", { channel: payload.channel, userId: payload.userId, sessionId, requestId: rid });
        return json(200, { requestId: rid, sessionId, answer, userId: payload.userId });
      } catch (err) {
        countRequest(ERROR_CODES.ASSISTANT_UNAVAILABLE, payload.channel);
        audit({ requestId: rid, action: "forward", status: "error", error: String(err) });
        logger.error("forward failed", { error: String(err), channel: payload.channel, userId: payload.userId, requestId: rid });
        return json(502, { error: ERROR_CODES.ASSISTANT_UNAVAILABLE, requestId: rid });
      }
    }

    logger.debug("not_found", { requestId: rid, method: req.method, path: url.pathname });
    return json(404, { error: ERROR_CODES.NOT_FOUND });
  },
});

logger.info("started", {
  port: PORT,
  rateLimits: {
    userMax: USER_RATE_LIMIT,
    userWindowMs: USER_RATE_WINDOW_MS,
    channelMax: CHANNEL_RATE_LIMIT,
    channelWindowMs: CHANNEL_RATE_WINDOW_MS,
  },
  nonceWindowMs: NONCE_WINDOW_MS,
  nonceMaxSize: NONCE_MAX_SIZE,
  sessionTtlMs: SESSION_TTL_MS,
});
