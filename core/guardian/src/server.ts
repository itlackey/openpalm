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

import { ERROR_CODES, validatePayload } from "@openpalm/lib/shared/channel.ts";
import { verifySignature } from "@openpalm/lib/shared/crypto.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const logger = createLogger("guardian");

// ── Config ──────────────────────────────────────────────────────────────

const PORT = Number(Bun.env.PORT ?? 8080);
const ASSISTANT_URL = Bun.env.OPENPALM_ASSISTANT_URL ?? "http://assistant:4096";
const AUDIT_PATH = Bun.env.GUARDIAN_AUDIT_PATH ?? "/app/data/audit.log";
const SECRETS_PATH = Bun.env.GUARDIAN_SECRETS_PATH;

// ── Channel secrets ─────────────────────────────────────────────────────

const CHANNEL_SECRET_RE = /^CHANNEL_[A-Z0-9_]+_SECRET$/;

function parseChannelSecrets(content: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (CHANNEL_SECRET_RE.test(key) && val) {
      const ch = key.replace(/^CHANNEL_/, "").replace(/_SECRET$/, "").toLowerCase();
      secrets[ch] = val;
    }
  }
  return secrets;
}

async function loadChannelSecrets(): Promise<Record<string, string>> {
  if (SECRETS_PATH) {
    try {
      const content = await Bun.file(SECRETS_PATH).text();
      return parseChannelSecrets(content);
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

function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  // Evict stale buckets when map is too large
  if (buckets.size > 10000) {
    for (const [k, b] of buckets) {
      if (now - b.start > windowMs) buckets.delete(k);
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

function checkNonce(nonce: string, ts: number): boolean {
  if (Math.abs(Date.now() - ts) > CLOCK_SKEW) return false;
  if (seen.has(nonce)) return false;
  seen.set(nonce, ts);

  // Time-based pruning: clean expired entries periodically
  if (seen.size > 100) {
    const cutoff = Date.now() - CLOCK_SKEW;
    for (const [k, v] of seen) {
      if (v < cutoff) seen.delete(k);
    }
  }
  return true;
}

// ── Audit ───────────────────────────────────────────────────────────────

// Ensure audit directory exists (Bun has no built-in mkdir; shell out once at startup)
const auditDir = AUDIT_PATH.slice(0, AUDIT_PATH.lastIndexOf("/"));
if (auditDir) {
  Bun.spawnSync(["mkdir", "-p", auditDir]);
}

// Use Bun.file().writer() for efficient append-only audit logging
const auditWriter = Bun.file(AUDIT_PATH).writer();

function audit(event: Record<string, unknown>) {
  auditWriter.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  auditWriter.flush();
}

// ── Assistant client ────────────────────────────────────────────────────
// Uses the OpenCode Server API:
//   1. POST /session        → create session → { id }
//   2. POST /session/:id/message → send message → { info, parts }

const ASSISTANT_AUTH = Bun.env.OPENCODE_SERVER_PASSWORD
  ? `Basic ${btoa(`${Bun.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${Bun.env.OPENCODE_SERVER_PASSWORD}`)}`
  : undefined;

// Longer timeout for message — LLM inference can be slow
const MESSAGE_TIMEOUT = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 120_000);

function assistantHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (ASSISTANT_AUTH) h["authorization"] = ASSISTANT_AUTH;
  return h;
}

async function askAssistant(message: string, userId: string, channel: string) {
  // Step 1: Create a session
  const createCtrl = new AbortController();
  const createTimer = setTimeout(() => createCtrl.abort(), 10_000);
  let ocSessionId: string;
  try {
    const resp = await fetch(`${ASSISTANT_URL}/session`, {
      method: "POST",
      headers: assistantHeaders(),
      signal: createCtrl.signal,
      body: JSON.stringify({ title: `${channel}/${userId}` }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`assistant POST /session ${resp.status}: ${body}`);
    }
    const session = await resp.json() as { id: string };
    ocSessionId = session.id;
    if (!/^[a-zA-Z0-9_-]+$/.test(ocSessionId)) {
      throw new Error("Invalid session ID from assistant");
    }
  } finally {
    clearTimeout(createTimer);
  }

  // Step 2: Send the user message and wait for response
  const msgCtrl = new AbortController();
  const msgTimer = setTimeout(() => msgCtrl.abort(), MESSAGE_TIMEOUT);
  try {
    const resp = await fetch(`${ASSISTANT_URL}/session/${ocSessionId}/message`, {
      method: "POST",
      headers: assistantHeaders(),
      signal: msgCtrl.signal,
      body: JSON.stringify({
        parts: [{ type: "text", text: message }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`assistant POST /session/${ocSessionId}/message ${resp.status}: ${body}`);
    }
    const data = await resp.json() as { info: unknown; parts: Array<{ type: string; text?: string; content?: string }> };

    // Extract text from response parts
    const texts: string[] = [];
    for (const part of data.parts ?? []) {
      if (part.type === "text" && part.text) {
        texts.push(part.text);
      }
    }
    return texts.join("\n") || "(no response)";
  } finally {
    clearTimeout(msgTimer);
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

    if (url.pathname === "/channel/inbound" && req.method === "POST") {
      const raw = await req.text();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return json(400, { error: ERROR_CODES.INVALID_JSON, requestId: rid }); }

      const validation = validatePayload(parsed);
      if (!validation.ok) return json(400, { error: validation.error, requestId: rid });
      const payload = validation.payload;

      const channelSecrets = await loadChannelSecrets();
      const secret = channelSecrets[payload.channel] ?? "";
      if (!secret) return json(403, { error: ERROR_CODES.CHANNEL_NOT_CONFIGURED, requestId: rid });

      const sig = req.headers.get("x-channel-signature") ?? "";
      if (!verifySignature(secret, raw, sig)) return json(403, { error: ERROR_CODES.INVALID_SIGNATURE, requestId: rid });

      if (!checkNonce(payload.nonce, payload.timestamp)) return json(409, { error: ERROR_CODES.REPLAY_DETECTED, requestId: rid });

      if (!allow(payload.userId, 120, 60_000) || !allow(`ch:${payload.channel}`, 200, 60_000)) {
        audit({ requestId: rid, action: "inbound", status: "denied", reason: ERROR_CODES.RATE_LIMITED, channel: payload.channel });
        return json(429, { error: ERROR_CODES.RATE_LIMITED, requestId: rid });
      }

      const sessionId = crypto.randomUUID();
      audit({ requestId: rid, sessionId, action: "inbound", status: "ok", channel: payload.channel, userId: payload.userId });

      try {
        const answer = await askAssistant(payload.text, payload.userId, payload.channel);
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
