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

import { parse as dotenvParse } from "dotenv";
import { ERROR_CODES, validatePayload } from "@openpalm/channels-sdk/channel";
import { verifySignature } from "@openpalm/channels-sdk/crypto";
import { createLogger } from "@openpalm/channels-sdk/logger";
import { asRecord } from "@openpalm/channels-sdk/utils";

const logger = createLogger("guardian");

// ── Config ──────────────────────────────────────────────────────────────

const PORT = Number(Bun.env.PORT ?? 8080);
const ASSISTANT_URL = Bun.env.OPENPALM_ASSISTANT_URL ?? "http://assistant:4096";
const AUDIT_PATH = Bun.env.GUARDIAN_AUDIT_PATH ?? "/app/audit/guardian-audit.log";
const SECRETS_PATH = Bun.env.GUARDIAN_SECRETS_PATH;

// ── Channel secrets ─────────────────────────────────────────────────────

const CHANNEL_SECRET_RE = /^CHANNEL_[A-Z0-9_]+_SECRET$/;

function parseChannelSecrets(content: string): Record<string, string> {
  const parsed = dotenvParse(content);
  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (CHANNEL_SECRET_RE.test(key) && typeof val === "string" && val) {
      const ch = key.replace(/^CHANNEL_/, "").replace(/_SECRET$/, "").toLowerCase();
      secrets[ch] = val;
    }
  }
  return secrets;
}

// Cache for file-based secrets to avoid reading on every request
let secretsCache: { mtime: number; loadedAt: number; secrets: Record<string, string> } | null = null;
const SECRETS_CACHE_TTL_MS = Math.max(5000, Number(Bun.env.GUARDIAN_SECRETS_CACHE_TTL_MS) || 30_000);

async function loadChannelSecrets(): Promise<Record<string, string>> {
  if (SECRETS_PATH) {
    try {
      const file = Bun.file(SECRETS_PATH);
      const mtime = file.lastModified;
      if (secretsCache
        && secretsCache.mtime === mtime
        && Date.now() - secretsCache.loadedAt < SECRETS_CACHE_TTL_MS) {
        return secretsCache.secrets;
      }
      const content = await file.text();
      const secrets = parseChannelSecrets(content);
      secretsCache = { mtime, loadedAt: Date.now(), secrets };
      return secrets;
    } catch {
      logger.warn("secrets_file_unreadable", { path: SECRETS_PATH });
      return {};
    }
  }
  // Fallback: read from process env (dev/test without GUARDIAN_SECRETS_PATH)
  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(Bun.env)) {
    if (CHANNEL_SECRET_RE.test(key) && val) {
      const ch = key.replace(/^CHANNEL_/, "").replace(/_SECRET$/, "").toLowerCase();
      secrets[ch] = val;
    }
  }
  return secrets;
}

// ── Rate limiter ────────────────────────────────────────────────────────

const buckets = new Map<string, { count: number; start: number }>();

// NOTE: This is a fixed-window rate limiter. A client can send `limit` requests
// at the end of one window and `limit` at the start of the next, achieving 2x burst
// in a short span. This is acceptable for the guardian's use case (LAN-first,
// secondary to HMAC auth), but could be upgraded to a sliding window if needed.
function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  // Evict stale buckets when map is too large
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (now - b.start > windowMs) buckets.delete(k);
    }

    // Hard cap: if still over 10,000 after pruning expired, delete oldest entries first
    if (buckets.size > 10_000) {
      const sorted = [...buckets.entries()].sort((a, b) => a[1].start - b[1].start);
      const toRemove = sorted.slice(0, sorted.length - 10_000);
      for (const [k] of toRemove) buckets.delete(k);
    }
  }

  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    buckets.set(key, { count: 1, start: now });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

// ── Nonce cache ─────────────────────────────────────────────────────────

const CLOCK_SKEW = 300_000;
const seen = new Map<string, number>();

function pruneNonceCache(): void {
  const cutoff = Date.now() - CLOCK_SKEW;
  for (const [k, v] of seen) {
    if (v < cutoff) seen.delete(k);
  }

  // Hard cap: if still over 50,000 after pruning expired, delete oldest entries first
  if (seen.size > 50_000) {
    const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, sorted.length - 50_000);
    for (const [k] of toRemove) seen.delete(k);
  }
}

// Periodic pruning every 60 seconds regardless of map size
setInterval(pruneNonceCache, 60_000);

function checkNonce(nonce: string, ts: number): boolean {
  if (Math.abs(Date.now() - ts) > CLOCK_SKEW) return false;
  if (seen.has(nonce)) return false;
  seen.set(nonce, ts);

  // Time-based pruning: clean expired entries when map grows large
  if (seen.size > 10_000) {
    pruneNonceCache();
  }
  return true;
}

// ── Audit ───────────────────────────────────────────────────────────────

// Ensure audit directory exists (Bun has no built-in mkdir; shell out once at startup)
const auditDir = AUDIT_PATH.slice(0, AUDIT_PATH.lastIndexOf("/"));
if (auditDir) {
  const result = Bun.spawnSync(["mkdir", "-p", auditDir]);
  if (result.exitCode !== 0) console.error("Failed to create audit directory:", auditDir);
}

// Use Bun.file().writer() for efficient append-only audit logging
const auditWriter = Bun.file(AUDIT_PATH).writer();

function audit(event: Record<string, unknown>) {
  try {
    auditWriter.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    auditWriter.flush();
  } catch (err) {
    console.error("Audit flush failed:", err);
  }
}

// ── Assistant client ────────────────────────────────────────────────────
// Uses the shared assistant HTTP client from @openpalm/channels-sdk.

import {
  createSession,
  sendMessage,
} from "@openpalm/channels-sdk/assistant-client";
import type { AssistantClientOptions } from "@openpalm/channels-sdk/assistant-client";

const MESSAGE_TIMEOUT = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 120_000);
const SESSION_TTL_MS = Number(Bun.env.GUARDIAN_SESSION_TTL_MS ?? 15 * 60_000);
const SESSION_KEY_MAX_LENGTH = 256;

const sessionCache = new Map<string, { sessionId: string; lastUsed: number }>();

// Periodic cleanup of expired sessions + hard cap at 10,000
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now - entry.lastUsed > SESSION_TTL_MS) sessionCache.delete(key);
  }

  // Hard cap: if still over 10,000 after pruning expired, delete oldest entries first
  if (sessionCache.size > 10_000) {
    const sorted = [...sessionCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, sorted.length - 10_000);
    for (const [k] of toRemove) sessionCache.delete(k);
  }
}, 5 * 60_000);

function clientOpts(): AssistantClientOptions {
  return {
    baseUrl: ASSISTANT_URL,
    username: Bun.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    password: Bun.env.OPENCODE_SERVER_PASSWORD,
    messageTimeoutMs: MESSAGE_TIMEOUT,
  };
}

type SessionTarget = {
  cacheKey: string;
  sessionKey: string;
};

function resolveSessionTarget(userId: string, channel: string, metadata: unknown): SessionTarget {
  const meta = asRecord(metadata);
  const metadataSessionKey = typeof meta?.sessionKey === "string"
    ? meta.sessionKey.trim()
    : "";
  const sessionKey = metadataSessionKey && metadataSessionKey.length <= SESSION_KEY_MAX_LENGTH
    ? metadataSessionKey
    : userId;

  return {
    cacheKey: `${channel}:${sessionKey}`,
    sessionKey,
  };
}

function shouldClearSession(metadata: unknown): boolean {
  return asRecord(metadata)?.clearSession === true;
}

async function askAssistant(
  message: string,
  userId: string,
  channel: string,
  sessionTarget: SessionTarget,
): Promise<{ answer: string; sessionId: string }> {
  const cacheKey = sessionTarget.cacheKey;
  const opts = clientOpts();
  const cached = sessionCache.get(cacheKey);

  // Try reusing cached session
  if (cached && Date.now() - cached.lastUsed < SESSION_TTL_MS) {
    try {
      const answer = await sendMessage(opts, cached.sessionId, message);
      cached.lastUsed = Date.now();
      return { answer, sessionId: cached.sessionId };
    } catch {
      // Session expired or invalid — fall through to create new one
      sessionCache.delete(cacheKey);
    }
  }

  // Create new session
  const title = `${channel}/${userId}`;
  const sessionId = await createSession(opts, title);
  const answer = await sendMessage(opts, sessionId, message);
  sessionCache.set(cacheKey, { sessionId, lastUsed: Date.now() });
  return { answer, sessionId };
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

    if (url.pathname === "/channel/inbound" && req.method === "POST") {
      // H8: Request body size limit (100KB)
      const contentLength = req.headers.get("content-length");
      if (contentLength && Number(contentLength) > 102_400) {
        return json(413, { error: ERROR_CODES.PAYLOAD_TOO_LARGE, requestId: rid });
      }

      const raw = await req.text();

      if (raw.length > 102_400) {
        return json(413, { error: ERROR_CODES.PAYLOAD_TOO_LARGE, requestId: rid });
      }

      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return json(400, { error: ERROR_CODES.INVALID_JSON, requestId: rid }); }

      const validation = validatePayload(parsed);
      if (!validation.ok) return json(400, { error: validation.error, requestId: rid });
      const payload = validation.payload;

      // C1: Use dummy secret for unknown channels to prevent channel name enumeration.
      // Both unknown channels and bad signatures return invalid_signature.
      const channelSecrets = await loadChannelSecrets();
      const secret = channelSecrets[payload.channel] ?? "";

      const sig = req.headers.get("x-channel-signature") ?? "";
      if (!verifySignature(secret || "dummy-secret-for-timing-parity", raw, sig)) {
        return json(403, { error: ERROR_CODES.INVALID_SIGNATURE, requestId: rid });
      }

      // H3: Rate limit before nonce check to prevent nonce consumption for rate-limited requests
      if (!allow(payload.userId, 120, 60_000) || !allow(`ch:${payload.channel}`, 200, 60_000)) {
        audit({ requestId: rid, action: "inbound", status: "denied", reason: ERROR_CODES.RATE_LIMITED, channel: payload.channel });
        return json(429, { error: ERROR_CODES.RATE_LIMITED, requestId: rid });
      }

      if (!checkNonce(payload.nonce, payload.timestamp)) return json(409, { error: ERROR_CODES.REPLAY_DETECTED, requestId: rid });

      const sessionTarget = resolveSessionTarget(payload.userId, payload.channel, payload.metadata);

      if (shouldClearSession(payload.metadata)) {
        sessionCache.delete(sessionTarget.cacheKey);
        audit({
          requestId: rid,
          action: "clear_session",
          status: "ok",
          channel: payload.channel,
          userId: payload.userId,
          sessionKey: sessionTarget.sessionKey,
        });
        return json(200, {
          requestId: rid,
          cleared: true,
          userId: payload.userId,
        });
      }

      try {
        const { answer, sessionId } = await askAssistant(payload.text, payload.userId, payload.channel, sessionTarget);
        audit({
          requestId: rid,
          sessionId,
          action: "inbound",
          status: "ok",
          channel: payload.channel,
          userId: payload.userId,
          sessionKey: sessionTarget.sessionKey,
        });
        return json(200, { requestId: rid, sessionId, answer, userId: payload.userId });
      } catch (err) {
        audit({ requestId: rid, action: "forward", status: "error", error: String(err) });
        return json(502, { error: ERROR_CODES.ASSISTANT_UNAVAILABLE, requestId: rid });
      }
    }

    return json(404, { error: ERROR_CODES.NOT_FOUND });
  },
});

logger.info("started", { port: PORT });
