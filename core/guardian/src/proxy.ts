/**
 * Guardian /oc/* reverse proxy — native OpenCode passthrough with security gates.
 *
 * This is ~95% a byte-for-byte transparent reverse proxy (the UI proxy pattern:
 * stream `upstream.body` untouched, never buffer), PLUS the fail-closed gates from
 * the rich-UX design (docs/technical/channel-rich-ux-design.md §2–§3). Stage 1
 * implements:
 *
 *   1. Per-call HMAC verify (signed userId) — §3.1, channels-sdk verifyRequest.
 *   2. Endpoint allowlist, default-deny, hardened matching — §3.3, channels-sdk
 *      matchAllowlist.
 *   3. Session-ownership authz + POST /session create-body rewrite + GET /session
 *      response filtering — §3.4, guardian-local ownership.ts.
 *   4. Transparent streaming passthrough of the response body — §0, UI proxy.
 *   5. Content moderation of message/prompt bodies — §3.5, WRITE-PATH ONLY,
 *      fail-closed, reuses moderation.ts (Stage 3, screenPromptBody below).
 *
 * Stage 4 adds (this change):
 *   6. Permission-reply ownership (§3.4): the /event relay records
 *      requestID→principal; a reply is authorized against that record so
 *      principal A cannot answer principal B's request. Fresh per-call signing.
 *   7. Resource bounds (§3.6): per-user/per-channel proxy call rate limits
 *      (reused rate-limit.ts), a /event reconnect cap, a concurrent-/event-
 *      stream cap (1/principal), and an in-flight-turn cap with a per-turn
 *      wall-clock abort — all in guardian-local oc-bounds.ts.
 *
 * The legacy buffered POST /channel/inbound path is untouched; this route is
 * purely additive (§7).
 */

import { matchAllowlist, type AllowlistMatch } from "@openpalm/channels-sdk/oc-allowlist";
import { verifyRequest, type RequestSignatureFields } from "@openpalm/channels-sdk/crypto";
import { createLogger } from "@openpalm/channels-sdk/logger";

import { checkNonce } from "./replay";
import {
  type Principal,
  ownsSession,
  ownsPermission,
  recordSessionOwner,
  forgetSession,
  ownedSessionIds,
} from "./ownership";
import { resolveSessionTarget } from "./forward";
import { openEventStream } from "./event-fanout";
import { audit } from "./audit";
import { moderateMessage } from "./moderation";
import {
  allow,
  USER_RATE_LIMIT,
  USER_RATE_WINDOW_MS,
  CHANNEL_RATE_LIMIT,
  CHANNEL_RATE_WINDOW_MS,
} from "./rate-limit";
import {
  allowEventReconnect,
  reserveEventStream,
  releaseEventStream,
  beginTurn,
  endTurn,
  endTurnsForSession,
  setTurnAbortFn,
} from "./oc-bounds";

const logger = createLogger("guardian:proxy");

// ── Config ──────────────────────────────────────────────────────────────

/** Base path under which the native OpenCode proxy is served. */
export const OC_PREFIX = "/oc";

const ASSISTANT_URL = Bun.env.OP_ASSISTANT_URL ?? "http://assistant:4096";
const OC_MAX_BODY_BYTES = Number(Bun.env.GUARDIAN_OC_MAX_BODY_BYTES ?? 1_048_576); // 1 MiB

// Wire the stale-turn reaper's abort side-effect (§3.6 per-turn wall-clock cap).
// The bounds module mints turn ids and detects breaches but cannot issue the
// upstream abort itself (it must stay free of the upstream fetch to remain
// unit-testable); the proxy owns that side-effect. Best-effort, fire-and-forget.
setTurnAbortFn((sessionId) => {
  const auth = upstreamAuthHeader();
  const headers = new Headers({ "content-type": "application/json" });
  if (auth) headers.set("authorization", auth);
  void fetch(`${ASSISTANT_URL}/session/${sessionId}/abort`, { method: "POST", headers, body: "{}" })
    .then(() => logger.warn("oc_turn_wall_clock_abort", { sessionId }))
    .catch((err) => logger.error("oc_turn_abort_failed", { sessionId, error: String(err) }));
});

function readSecretFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return Bun.file(path).textSync().replace(/[\r\n]+$/, "");
  } catch {
    return undefined;
  }
}

// Server-to-server Basic auth to the upstream OpenCode (same creds the buffered
// forward path uses). Computed once.
const UPSTREAM_USERNAME = Bun.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const UPSTREAM_PASSWORD =
  readSecretFile(Bun.env.OPENCODE_SERVER_PASSWORD_FILE) ?? Bun.env.OPENCODE_SERVER_PASSWORD;

function upstreamAuthHeader(): string | undefined {
  if (!UPSTREAM_PASSWORD) return undefined;
  const encoded = Buffer.from(`${UPSTREAM_USERNAME}:${UPSTREAM_PASSWORD}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

// ── Header names (wire contract) ──────────────────────────────────────────

const H_SIG = "x-channel-signature";
const H_CHANNEL = "x-channel-name";
const H_USER = "x-channel-user-id";
const H_NONCE = "x-channel-nonce";
const H_TIMESTAMP = "x-channel-timestamp";

// ── Result type ───────────────────────────────────────────────────────────

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * Normalize a channel name to the secret-map key the same way the buffered path
 * does (lower-case, hyphens→underscores). MUST match server.ts inbound + the
 * CHANNEL_<NAME>_SECRET_FILE env-key derivation, else hyphenated channels 403.
 */
function channelKey(channel: string): string {
  return channel.toLowerCase().replace(/-/g, "_");
}

// ── Upstream request header construction ───────────────────────────────────

/**
 * Build a FRESH minimal header set for the upstream call — never forward the
 * channel's incoming headers wholesale (host/content-length/connection corrupt
 * the stream; the channel HMAC headers must not leak to the assistant). Mirrors
 * the UI proxy's buildForwardHeaders.
 */
function buildUpstreamHeaders(req: Request, hasBody: boolean): Headers {
  const headers = new Headers();
  if (hasBody) {
    const ct = req.headers.get("content-type");
    headers.set("content-type", ct ?? "application/json");
  }
  const auth = upstreamAuthHeader();
  if (auth) headers.set("authorization", auth);
  // Pass through the SSE Accept for /event so OpenCode streams text/event-stream.
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  return headers;
}

/**
 * Build a FRESH response header set — forward only streaming-relevant upstream
 * headers (content-type, cache-control, transfer-encoding) plus a diagnostic
 * request id. Mirrors the UI proxy's buildResponseHeaders.
 */
function buildResponseHeaders(upstream: Response, rid: string): Headers {
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  const transferEncoding = upstream.headers.get("transfer-encoding");
  if (transferEncoding) headers.set("transfer-encoding", transferEncoding);
  headers.set("x-request-id", rid);
  return headers;
}

// ── Main handler ───────────────────────────────────────────────────────────

/**
 * Handle a /oc/* request. The caller (server.ts) has already matched the
 * pathname prefix; `req` is the full request and `rid` the request id.
 *
 * Returns a Response. On any gate failure it returns a 4xx and audits;
 * otherwise it forwards transparently and streams `upstream.body` back.
 *
 * `secretFor` resolves a channel's HMAC secret (so server.ts owns secret
 * loading/caching and this stays pure-ish + unit-testable). It returns "" for
 * unknown channels.
 */
export async function handleProxy(
  req: Request,
  rid: string,
  secretFor: (channelKey: string) => string,
): Promise<Response> {
  const url = new URL(req.url);

  // The OpenCode path is everything after the /oc prefix. Use the RAW encoded
  // pathname so the allowlist can decode/canonicalize itself (it must see the
  // pre-decoded form to reject `%2e%2e` traversal). url.pathname is already
  // percent-decoded by URL — so reconstruct the raw path from the original URL.
  const rawPath = rawOcPath(req.url);
  if (rawPath === null) {
    return deny(rid, 404, "not_found", { reason: "no_oc_prefix" });
  }

  const method = req.method;

  // ── Gate 1a: read + reconstruct the signed material from headers ──────────
  const channel = req.headers.get(H_CHANNEL) ?? "";
  const userId = req.headers.get(H_USER) ?? "";
  const nonce = req.headers.get(H_NONCE) ?? "";
  const timestampRaw = req.headers.get(H_TIMESTAMP) ?? "";
  const sig = req.headers.get(H_SIG) ?? "";
  const timestamp = Number(timestampRaw);

  // ── Read the body (bounded) BEFORE signature so SHA256(body) can be checked ──
  let body = "";
  if (method !== "GET" && method !== "HEAD") {
    body = await req.text();
    if (body.length > OC_MAX_BODY_BYTES) {
      return deny(rid, 413, "payload_too_large", { channel, userId, bodyLength: body.length });
    }
  }

  // ── Gate 1b: per-call HMAC verify (signed userId) ────────────────────────
  // ALWAYS run a verify even for unknown channels (dummy secret) to avoid a
  // timing/enumeration oracle (mirrors the buffered path's C1 discipline).
  const secret = channel ? secretFor(channelKey(channel)) : "";
  const fields: RequestSignatureFields = {
    method,
    pathWithQuery: rawPath + url.search,
    body,
    nonce,
    timestamp,
    userId,
  };
  if (!userId || !nonce || !timestampRaw || Number.isNaN(timestamp)) {
    // Run a dummy verify for timing parity, then reject.
    verifyRequest("dummy-secret-for-timing-parity", fields, sig);
    return deny(rid, 403, "invalid_signature", { channel, reason: "missing_signed_fields" });
  }
  if (!secret) {
    verifyRequest("dummy-secret-for-timing-parity", fields, sig);
    return deny(rid, 403, "invalid_signature", { channel, reason: "unknown_channel" });
  }
  if (!verifyRequest(secret, fields, sig)) {
    return deny(rid, 403, "invalid_signature", { channel, userId });
  }

  // ── Gate 1c: per-user / per-channel rate limit (§3.6) — counts discrete ──
  // signed calls (a GET /event open counts as one). BEFORE the nonce check (H3
  // discipline: a rate-limited flood must not burn nonce-store capacity).
  if (
    !allow(`oc:${userId}`, USER_RATE_LIMIT, USER_RATE_WINDOW_MS) ||
    !allow(`oc:ch:${channel}`, CHANNEL_RATE_LIMIT, CHANNEL_RATE_WINDOW_MS)
  ) {
    return deny(rid, 429, "rate_limited", { channel, userId });
  }

  // ── Gate 1d: replay protection (reuse the buffered path's nonce store) ────
  if (!checkNonce(nonce, timestamp)) {
    return deny(rid, 409, "replay_detected", { channel, userId, nonce });
  }

  // ── Gate 2: endpoint allowlist, default-deny, hardened matching ──────────
  const match = matchAllowlist(method, rawPath);
  if (!match.allowed) {
    return deny(rid, 403, "forbidden_endpoint", { channel, userId, method, path: rawPath, reason: match.reason });
  }

  const principal: Principal = { channel, userId };

  // ── Gate 3: session/permission ownership + body rewrite + filtering ──────
  return await routeAllowed(req, rid, principal, match, rawPath, url.search, body, secret);
}

/**
 * Apply per-route ownership gates, then forward. `match.route.template` is the
 * canonical template; `match.params` holds {id}/{requestID}.
 */
async function routeAllowed(
  req: Request,
  rid: string,
  principal: Principal,
  match: AllowlistMatch,
  rawPath: string,
  search: string,
  body: string,
  _secret: string,
): Promise<Response> {
  const template = match.route!.template;
  const params = match.params ?? {};
  const sessionId = params.id;
  const requestID = params.requestID;

  // POST /session — guardian CONSTRUCTS the body (title) and DISCARDS the
  // client's; records ownership SYNCHRONOUSLY on the create response (§3.4).
  if (template === "/session" && req.method === "POST") {
    return await forwardSessionCreate(req, rid, principal, rawPath, search);
  }

  // GET /session — response filtered to the principal's own sessions (§3.4).
  if (template === "/session" && req.method === "GET") {
    return await forwardSessionList(req, rid, principal, rawPath, search, body);
  }

  // POST /permission/{requestID}/reply — own requestID only (§3.4). The /event
  // fan-out records requestID→principal when it relays the permission.asked
  // frame (event-fanout.ts), so only the principal that was SHOWN the request
  // can answer it. A reply for an unrelayed/foreign requestID is fail-closed
  // denied (principal A cannot answer principal B's request). The reply itself
  // carries fresh per-call signing (new nonce/timestamp) verified above — never
  // the originating prompt_async nonce (§3.1).
  if (template === "/permission/{requestID}/reply") {
    if (!requestID || !ownsPermission(requestID, principal)) {
      return deny(rid, 403, "forbidden_permission", { channel: principal.channel, userId: principal.userId, requestID });
    }
    return await forwardTransparent(req, rid, rawPath, search, body);
  }

  // All other allowlisted routes are session-scoped: assert ownership of {id}.
  if (sessionId !== undefined) {
    if (!ownsSession(sessionId, principal)) {
      return deny(rid, 403, "forbidden_session", { channel: principal.channel, userId: principal.userId, sessionId });
    }
    // Gate 4: content moderation — WRITE-PATH ONLY (§3.5). Only the two
    // prompt-bearing POSTs are screened; everything else (GET/DELETE/abort)
    // forwards transparently. Responses are NEVER screened (the assistant is
    // the trust boundary for its own output).
    if (
      req.method === "POST" &&
      (template === "/session/{id}/message" || template === "/session/{id}/prompt_async")
    ) {
      const blocked = await screenPromptBody(rid, principal, template, body);
      if (blocked) return blocked;
      // §3.6 in-flight-turn cap: a prompt turn holds assistant compute until the
      // session goes idle. Bound how many a principal can hold concurrently; the
      // (cap+1)th is 429'd.
      const turnId = beginTurn(principal, sessionId);
      if (turnId === null) {
        return deny(rid, 429, "too_many_inflight_turns", {
          channel: principal.channel,
          userId: principal.userId,
          sessionId,
        });
      }
      // A turn's slot must be released at the REAL end of the turn, which differs
      // by endpoint:
      //  - /message is BLOCKING: the upstream response IS turn-end → end in finally.
      //  - /prompt_async returns 204 immediately while the model keeps working →
      //    the turn ends when the /event fan-out observes session-idle for this
      //    session (event-fanout → endTurnsForSession), with the wall-clock sweep
      //    (setTurnAbortFn) as the backstop. Ending it here in finally would zero
      //    the accounting instantly and make BOTH the in-flight cap and the
      //    wall-clock abort dead (the bug this guards against). So only end early
      //    on a non-OK upstream response — the turn never actually started.
      if (template === "/session/{id}/message") {
        try {
          return await forwardTransparent(req, rid, rawPath, search, body);
        } finally {
          endTurn(turnId);
        }
      }
      const asyncResp = await forwardTransparent(req, rid, rawPath, search, body);
      if (!asyncResp.ok) endTurn(turnId);
      return asyncResp;
    }
    // DELETE succeeds → forget ownership after a clean upstream response.
    if (req.method === "DELETE" && template === "/session/{id}") {
      const resp = await forwardTransparent(req, rid, rawPath, search, body);
      if (resp.ok) {
        forgetSession(sessionId);
        endTurnsForSession(sessionId); // release any lingering turn for a deleted session
      }
      return resp;
    }
    return await forwardTransparent(req, rid, rawPath, search, body);
  }

  // GET /event — multiplexes ALL sessions; a transparent passthrough would
  // cross-leak (§3.2). The guardian holds ONE upstream subscription and fans
  // out only the frames whose sessionID this principal owns; no-sessionID
  // (global) frames are hard-dropped. permission.asked frames also record
  // requestID→principal so the reply gate can authorize it (§3.4).
  if (template === "/event") {
    // §3.6 reconnect cap: bound /event opens per principal per window so a
    // reconnect loop cannot churn nonces and pressure the replay store.
    if (!allowEventReconnect(principal)) {
      return deny(rid, 429, "event_reconnect_limited", { channel: principal.channel, userId: principal.userId });
    }
    // §3.6 concurrent-stream cap: at most N held-open streams per principal.
    // Reserve a slot; release it when the stream closes (client abort/cancel).
    if (!reserveEventStream(principal)) {
      return deny(rid, 429, "too_many_event_streams", { channel: principal.channel, userId: principal.userId });
    }
    audit({ requestId: rid, action: "oc_event_open", status: "ok", channel: principal.channel, userId: principal.userId });
    const resp = openEventStream(principal, req.signal);
    // Release the concurrency slot once the client disconnects. openEventStream
    // wires the same signal to drop the subscriber; we mirror it for the slot so
    // a closed stream frees the principal to reconnect.
    const release = () => releaseEventStream(principal);
    if (req.signal.aborted) release();
    else req.signal.addEventListener("abort", release, { once: true });
    return resp;
  }

  // Unreachable: every allowlisted template is handled above.
  return deny(rid, 403, "forbidden_endpoint", { channel: principal.channel, userId: principal.userId, path: rawPath });
}

/**
 * Gate 4 — content moderation of a prompt-bearing body (§3.5). WRITE-PATH ONLY.
 *
 * Parses the `message`/`prompt_async` body, extracts every `parts[].text`,
 * concatenates them, and runs the EXISTING heuristic-screen → local-moderator
 * pipeline (moderation.ts) fail-closed. Returns a 403 Response to BLOCK, or
 * null to let the caller forward.
 *
 * ── OPENCODE REQUEST-BODY SCHEMA COUPLING — pinned to OPENCODE_VERSION ──
 * This is the SINGLE place the proxy reaches inside an OpenCode request body
 * (design §3.5/§5). The shape is `{ parts: [{ type: "text", text: string }, …] }`
 * for both POST /session/{id}/message and POST /session/{id}/prompt_async on the
 * pinned OpenCode version. If OpenCode changes this shape on a version bump, the
 * drift guard (§5, Stage 7) fails the proxy route closed; keep this isolated and
 * update it in lockstep with OPENCODE_VERSION. Nothing else here parses bodies.
 *
 * Fail-closed posture: an unparseable body is treated as having no extractable
 * text and screened as "" — moderation of empty text allows, so the upstream
 * still validates the actual shape. A `block` verdict (incl. the moderator being
 * unreachable/unparseable — moderateMessage collapses those to a fail-closed
 * block internally) short-circuits before the assistant is ever contacted.
 */
async function screenPromptBody(
  rid: string,
  principal: Principal,
  template: string,
  body: string,
): Promise<Response | null> {
  const text = extractPromptText(body);
  const moderation = await moderateMessage(text, undefined);
  if (moderation.verdict === "block") {
    return deny(rid, 403, "content_blocked", {
      channel: principal.channel,
      userId: principal.userId,
      template,
      source: moderation.source,
      reason: moderation.reason,
      signals: moderation.signals,
      score: moderation.score,
    });
  }
  if (moderation.verdict === "flag") {
    logger.warn("oc_content_flagged", {
      requestId: rid,
      channel: principal.channel,
      userId: principal.userId,
      template,
      reason: moderation.reason,
      signals: moderation.signals,
      score: moderation.score,
    });
  }
  return null;
}

/**
 * Extract and concatenate the text of every `parts[].text` entry from a
 * message/prompt_async body. Returns "" for any body that is not the pinned
 * OpenCode shape (see the schema-coupling note on screenPromptBody).
 */
function extractPromptText(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  const parts = (parsed as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    const t = (part as { text?: unknown })?.text;
    if (typeof t === "string" && t) texts.push(t);
  }
  return texts.join("\n");
}

/**
 * POST /session: discard the client body, construct `{ title }` from the
 * principal-derived sessionKey, forward, then record sessionId→principal
 * synchronously from the create response before returning.
 */
async function forwardSessionCreate(
  req: Request,
  rid: string,
  principal: Principal,
  rawPath: string,
  search: string,
): Promise<Response> {
  // Derive the session title exactly as the buffered path does. The channel can
  // no longer inject an arbitrary title (prompt-injection / moderation-bypass).
  // metadata.sessionKey may ride as a header so multi-thread channels keep their
  // grouping; absent → falls back to userId inside resolveSessionTarget.
  const sessionKeyHeader = req.headers.get("x-channel-session-key") ?? undefined;
  const metadata = sessionKeyHeader ? { sessionKey: sessionKeyHeader } : undefined;
  const target = resolveSessionTarget(principal.userId, principal.channel, metadata);
  const rewritten = JSON.stringify({ title: `${principal.channel}:${target.sessionKey}` });

  const upstream = await fetchUpstream(req, rawPath, search, rewritten);
  // Read the create response to record ownership; this is a small JSON body so
  // buffering it is fine (it is NOT a stream).
  const text = await upstream.text();
  if (upstream.ok) {
    try {
      const parsed = JSON.parse(text) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id) {
        recordSessionOwner(parsed.id, principal);
        audit({ requestId: rid, action: "oc_session_create", status: "ok", channel: principal.channel, userId: principal.userId, sessionId: parsed.id });
      }
    } catch {
      logger.warn("oc_session_create_unparsable", { requestId: rid, channel: principal.channel, userId: principal.userId });
    }
  }
  return new Response(text, { status: upstream.status, headers: buildResponseHeaders(upstream, rid) });
}

/**
 * GET /session: forward, then filter the returned array to the principal's own
 * sessions so other principals' titles never leak. Small JSON body — buffer it.
 */
async function forwardSessionList(
  req: Request,
  rid: string,
  principal: Principal,
  rawPath: string,
  search: string,
  body: string,
): Promise<Response> {
  const upstream = await fetchUpstream(req, rawPath, search, body);
  const text = await upstream.text();
  if (!upstream.ok) {
    return new Response(text, { status: upstream.status, headers: buildResponseHeaders(upstream, rid) });
  }
  let filtered: unknown[] = [];
  try {
    const parsed = JSON.parse(text);
    const owned = ownedSessionIds(principal);
    if (Array.isArray(parsed)) {
      filtered = parsed.filter((s) => {
        const id = (s as { id?: unknown })?.id;
        return typeof id === "string" && owned.has(id);
      });
    }
  } catch {
    logger.warn("oc_session_list_unparsable", { requestId: rid, channel: principal.channel, userId: principal.userId });
    filtered = [];
  }
  return json(upstream.status, filtered);
}

/**
 * Transparent passthrough with streaming body — the UI-proxy precedent. Returns
 * `upstream.body` UNTOUCHED (never .text()/.json()/.arrayBuffer() — that would
 * buffer SSE in memory and break streaming). Status + streaming headers copied.
 */
async function forwardTransparent(
  req: Request,
  rid: string,
  rawPath: string,
  search: string,
  body: string,
): Promise<Response> {
  const upstream = await fetchUpstream(req, rawPath, search, body);
  return new Response(upstream.body, { status: upstream.status, headers: buildResponseHeaders(upstream, rid) });
}

/**
 * Issue the upstream fetch to the assistant OpenCode server. Wires the client's
 * abort signal to the upstream fetch (no fixed timeout — SSE streams run for
 * minutes; rely on client disconnect for teardown), mirroring the UI proxy.
 */
function fetchUpstream(
  req: Request,
  rawPath: string,
  search: string,
  body: string | undefined,
): Promise<Response> {
  const targetUrl = `${ASSISTANT_URL}${rawPath}${search}`;
  const method = req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener("abort", onClientAbort, { once: true });

  return fetch(targetUrl, {
    method,
    headers: buildUpstreamHeaders(req, hasBody),
    body: hasBody ? (body ?? "") : undefined,
    signal: controller.signal,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the RAW (still percent-encoded) OpenCode path from a request URL whose
 * pathname begins with `${OC_PREFIX}/`. Returns the path WITHOUT the /oc prefix
 * and WITHOUT the query string, or null if the prefix is absent.
 *
 * We parse the raw URL string (not url.pathname) because URL decodes percent
 * escapes — and the allowlist must see the encoded form to reject `%2e%2e`.
 */
function rawOcPath(rawUrl: string): string | null {
  // Strip scheme://host, then split off the query/fragment.
  const noScheme = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, "");
  const pathOnly = noScheme.split("?")[0].split("#")[0];
  if (pathOnly === OC_PREFIX) return "/"; // "/oc" alone → "/"
  if (!pathOnly.startsWith(OC_PREFIX + "/")) return null;
  return pathOnly.slice(OC_PREFIX.length); // keep the leading "/"
}

function deny(rid: string, status: number, error: string, detail: Record<string, unknown>): Response {
  audit({ requestId: rid, action: "oc_proxy", status: status >= 500 ? "error" : "denied", reason: error, ...detail });
  logger.warn("oc_proxy_denied", { requestId: rid, status, error, ...detail });
  return json(status, { error, requestId: rid });
}
