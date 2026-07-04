/**
 * Guardian /oc/* reverse proxy — native OpenCode passthrough with security gates.
 *
 * This is ~95% a byte-for-byte transparent reverse proxy (the UI proxy pattern:
 * stream `upstream.body` untouched, never buffer), PLUS the fail-closed gates from
 * the rich-UX design (docs/technical/portal-rich-ux-design.md §2–§3). Stage 1
 * implements:
 *
 *   1. Per-call Basic auth + user identity binding.
 *   2. Endpoint allowlist, default-deny, hardened matching — §3.3, oc-bounds.ts
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
 *      principal A cannot answer principal B's request.
 *   7. Resource bounds (§3.6): per-user/per-principal proxy call rate limits
 *      (reused rate-limit.ts), a /event reconnect cap, a concurrent-/event-
 *      stream cap (1/principal), and an in-flight-turn cap with a per-turn
 *      wall-clock abort — all in guardian-local oc-bounds.ts.
 *
 * The legacy buffered /portal/inbound transport has been removed; /oc/* is the
 * single assistant ingress path.
 */

import { matchAllowlist, type AllowlistMatch } from './oc-allowlist.ts';
import { createLogger } from './logger.ts';

import { json } from './http-util.ts';
import { authenticate } from "./auth";
import {
  type Principal,
  ownsSession,
  ownsPermission,
  recordSessionOwner,
  sessionOwnedByOther,
  forgetSession,
  ownedSessionIds,
} from "./ownership";
import { resolveSessionTarget } from "./session-target.ts";
import { openEventStream } from "./event-fanout";
import { audit } from "./audit";
import { moderateMessage, type ModerationResult } from "./moderation";
import {
  allow,
  USER_RATE_LIMIT,
  USER_RATE_WINDOW_MS,
  PORTAL_RATE_LIMIT,
  PORTAL_RATE_WINDOW_MS,
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
import { getPolicyProvider, type PolicyDecision } from "./policy";
import { ASSISTANT_URL, SESSION_TTL_MS as SESSION_REUSE_TTL_MS } from "./config";
import { BoundedTtlMap } from "./bounded-map";

const logger = createLogger("guardian:proxy");

// ── Config ──────────────────────────────────────────────────────────────

/** Base path under which the native OpenCode proxy is served. */
export const OC_PREFIX = "/oc";

const OC_MAX_BODY_BYTES = Number(Bun.env.GUARDIAN_OC_MAX_BODY_BYTES ?? 1_048_576); // 1 MiB

// Wire the stale-turn reaper's abort side-effect (§3.6 per-turn wall-clock cap).
// The bounds module mints turn ids and detects breaches but cannot issue the
// upstream abort itself (it must stay free of the upstream fetch to remain
// unit-testable); the proxy owns that side-effect. Best-effort, fire-and-forget.
setTurnAbortFn((sessionId) => {
  const headers = new Headers({ "content-type": "application/json" });
  void fetch(`${ASSISTANT_URL}/session/${sessionId}/abort`, { method: "POST", headers, body: "{}" })
    .then(() => logger.warn("oc_turn_wall_clock_abort", { sessionId }))
    .catch((err) => logger.error("oc_turn_abort_failed", { sessionId, error: String(err) }));
});

const H_SESSION_KEY = 'x-openpalm-session-key';

// ── Upstream request header construction ───────────────────────────────────

/**
 * Build a FRESH minimal header set for the upstream call — never forward the
 * portal's incoming headers wholesale (host/content-length/connection corrupt
 * the stream; inbound auth headers must not leak to the assistant). Mirrors
 * the UI proxy's buildForwardHeaders.
 */
function buildUpstreamHeaders(req: Request, hasBody: boolean): Headers {
  const headers = new Headers();
  if (hasBody) {
    const ct = req.headers.get("content-type");
    headers.set("content-type", ct ?? "application/json");
  }
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
 */
export async function handleProxy(
  req: Request,
  rid: string,
  expectedKind?: 'portal' | 'direct',
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

  // ── Read the body (bounded) BEFORE signature so SHA256(body) can be checked ──
  let body = "";
  if (method !== "GET" && method !== "HEAD") {
    body = await req.text();
    if (body.length > OC_MAX_BODY_BYTES) {
      return deny(rid, 413, "payload_too_large", { bodyLength: body.length });
    }
  }

  const authenticated = await authenticate(req, expectedKind);
  if (!authenticated) {
    return deny(rid, 401, 'unauthorized', {});
  }

  // ── Gate 1c: per-user / per-portal rate limit (§3.6) — counts discrete ──
  // signed calls (a GET /event open counts as one). BEFORE the nonce check (H3
  // discipline: a rate-limited flood must not burn nonce-store capacity).
  if (
    !allow(`user:oc:${authenticated.kind}:${authenticated.id}:${authenticated.userId}`, USER_RATE_LIMIT, USER_RATE_WINDOW_MS) ||
    !allow(`portal:oc:${authenticated.kind}:${authenticated.id}`, PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS)
  ) {
    return deny(rid, 429, "rate_limited", { principalId: authenticated.id, userId: authenticated.userId });
  }

  // ── Gate 2: endpoint allowlist, default-deny, hardened matching ──────────
  const match = authenticated.kind === 'portal'
    ? matchAllowlist(method, rawPath)
    : allowDirect(method, rawPath);
  if (!match.allowed) {
    return deny(rid, 403, "forbidden_endpoint", {
      principalId: authenticated.id,
      userId: authenticated.userId,
      method,
      path: rawPath,
      reason: match.reason,
    });
  }

  const principal: Principal = { id: authenticated.id, kind: authenticated.kind, userId: authenticated.userId };

  // ── Gate 2b: pluggable authorization policy (default permissive) ──────────
  let policyDecision: PolicyDecision;
  try {
    policyDecision = await getPolicyProvider().authorize({
      principalId: authenticated.id,
      kind: authenticated.kind,
      action: `oc:${method}`,
      resource: match.route?.template ?? rawPath,
      attributes: { userId: authenticated.userId, path: rawPath },
    });
  } catch (err) {
    // Fail closed on a policy-provider error, but never swallow the cause: log it
    // structured so an operator can see WHY the gate tripped (a bare `catch {}`
    // here previously collapsed every policy crash to an opaque 403).
    logger.error('oc_policy_error', {
      requestId: rid,
      principalId: authenticated.id,
      userId: authenticated.userId,
      error: String(err),
    });
    return deny(rid, 403, 'forbidden_policy', {
      principalId: authenticated.id,
      userId: authenticated.userId,
      reason: 'policy_error',
    });
  }
  if (!policyDecision.allow) {
    return deny(rid, 403, 'forbidden_policy', {
      principalId: authenticated.id,
      userId: authenticated.userId,
      reason: policyDecision.reason,
    });
  }

  // ── Gate 3: session/permission ownership + body rewrite + filtering ──────
  return await routeAllowed(req, rid, principal, match, rawPath, url.search, body);
}

function allowDirect(method: string, rawPath: string): AllowlistMatch {
  if (rawPath === '/doc' && method === 'GET') {
    return { allowed: true, route: { method, template: '/doc' }, params: {} } as AllowlistMatch;
  }
  const match = matchAllowlist(method, rawPath);
  if (match.allowed) return match;
  const route = directRouteFor(rawPath, method);
  if (route) return route;
  return match;
}

function directRouteFor(rawPath: string, method: string): AllowlistMatch | null {
  if (rawPath === '/event' && method === 'GET') {
    return { allowed: true, route: { method, template: '/event' }, params: {} } as AllowlistMatch;
  }
  const sessionRoot = rawPath.match(/^\/session\/([^/]+)$/);
  if (sessionRoot && (method === 'GET' || method === 'DELETE')) {
    return { allowed: true, route: { method, template: '/session/{id}' }, params: { id: sessionRoot[1] } } as AllowlistMatch;
  }
  const message = rawPath.match(/^\/session\/([^/]+)\/(message|prompt_async|abort)$/);
  if (message && method === 'POST') {
    return { allowed: true, route: { method, template: `/session/{id}/${message[2]}` }, params: { id: message[1] } } as AllowlistMatch;
  }
  const permission = rawPath.match(/^\/permission\/([^/]+)\/reply$/);
  if (permission && method === 'POST') {
    return { allowed: true, route: { method, template: '/permission/{requestID}/reply' }, params: { requestID: permission[1] } } as AllowlistMatch;
  }
  const question = rawPath.match(/^\/question\/([^/]+)\/(reply|reject)$/);
  if (question && method === 'POST') {
    return { allowed: true, route: { method, template: `/question/{requestID}/${question[2]}` }, params: { requestID: question[1] } } as AllowlistMatch;
  }
  return null;
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
): Promise<Response> {
  // biome-ignore lint/style/noNonNullAssertion: routeAllowed is only reached after the `!match.allowed` guard in handle(); every allowed AllowlistMatch (from matchAllowlist and allowDirect/directRouteFor) sets `route`, so it is provably non-null here.
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

  if (template === '/doc' && req.method === 'GET') {
    return await forwardTransparent(req, rid, rawPath, search, body);
  }

  // POST /permission/{requestID}/reply — own requestID only (§3.4). The /event
  // fan-out records requestID→principal when it relays the permission.asked
  // frame (event-fanout.ts), so only the principal that was SHOWN the request
  // can answer it. A reply for an unrelayed/foreign requestID is fail-closed
  // denied (principal A cannot answer principal B's request). The reply itself
  // carries fresh per-call Basic auth verified above — never
  // the originating prompt_async nonce (§3.1).
  if (template === "/permission/{requestID}/reply") {
    if (!requestID || !ownsPermission(requestID, principal)) {
      return deny(rid, 403, "forbidden_permission", { principalId: principal.id, userId: principal.userId, requestID });
    }
    return await forwardTransparent(req, rid, rawPath, search, body);
  }

  // Interactive `question` tool reply/reject — the parallel of permission reply.
  // Same ownership model: the /event relay recorded the que_ requestID→principal
  // when it forwarded question.asked, so only the principal shown the question
  // may answer/decline it (ownsPermission covers both per_ and que_ ids).
  if (template === "/question/{requestID}/reply" || template === "/question/{requestID}/reject") {
    if (!requestID || !ownsPermission(requestID, principal)) {
      return deny(rid, 403, "forbidden_question", { principalId: principal.id, userId: principal.userId, requestID });
    }
    return await forwardTransparent(req, rid, rawPath, search, body);
  }

  // All other allowlisted routes are session-scoped: assert ownership of {id}.
  if (sessionId !== undefined) {
    if (!ownsSession(sessionId, principal)) {
      return deny(rid, 403, "forbidden_session", { principalId: principal.id, userId: principal.userId, sessionId });
    }
    // Gate 4: content moderation — WRITE-PATH ONLY (§3.5). Only the two
    // prompt-bearing POSTs are screened; everything else (GET/DELETE/abort)
    // forwards transparently. Responses are NEVER screened (the assistant is
    // the trust boundary for its own output).
    if (
      req.method === "POST" &&
      (template === "/session/{id}/message" || template === "/session/{id}/prompt_async")
    ) {
      // Screen the prompt, then apply the block-vs-rewrite decision HERE so the
      // per-principal-kind policy is explicit at the call site (§3.5):
      //   - portal principals → hard 403 block (assistant never contacted);
      //   - direct principals → deliberate prompt-REWRITE into a refusal
      //     instruction, forwarded upstream so the caller gets a safe answer
      //     rather than a raw error. See the note on screenPromptBody.
      const moderation = await screenPromptBody(rid, principal, template, body);
      let promptBody = body;
      if (moderation.verdict === "block") {
        if (principal.kind === "direct") {
          promptBody = rewritePromptBody(body);
        } else {
          return deny(rid, 403, "content_blocked", {
            principalId: principal.id,
            userId: principal.userId,
            template,
            source: moderation.source,
            reason: moderation.reason,
            signals: moderation.signals,
            score: moderation.score,
          });
        }
      }
      // §3.6 in-flight-turn cap: a prompt turn holds assistant compute until the
      // session goes idle. Bound how many a principal can hold concurrently; the
      // (cap+1)th is 429'd.
      const turnId = beginTurn(principal, sessionId);
      if (turnId === null) {
        return deny(rid, 429, "too_many_inflight_turns", {
          principalId: principal.id,
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
           return await forwardTransparent(req, rid, rawPath, search, promptBody);
        } finally {
          endTurn(turnId);
        }
      }
      const asyncResp = await forwardTransparent(req, rid, rawPath, search, promptBody);
      if (!asyncResp.ok) endTurn(turnId);
      return asyncResp;
    }
    // DELETE succeeds → forget ownership after a clean upstream response.
    if (req.method === "DELETE" && template === "/session/{id}") {
      const resp = await forwardTransparent(req, rid, rawPath, search, body);
      if (resp.ok) {
        forgetSession(sessionId);
        endTurnsForSession(sessionId); // release any lingering turn for a deleted session
        evictOcSession(sessionId); // drop the reuse cache so /clear forces a fresh session
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
      return deny(rid, 429, "event_reconnect_limited", { principalId: principal.id, userId: principal.userId });
    }
    // §3.6 concurrent-stream cap: at most N held-open streams per principal.
    // Reserve a slot; release it when the stream closes (client abort/cancel).
    if (!reserveEventStream(principal)) {
      return deny(rid, 429, "too_many_event_streams", { principalId: principal.id, userId: principal.userId });
    }
      audit({ requestId: rid, action: "oc_event_open", status: "ok", portal: principal.id, userId: principal.userId });
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
  return deny(rid, 403, "forbidden_endpoint", { principalId: principal.id, userId: principal.userId, path: rawPath });
}

/**
 * Gate 4 — content moderation of a prompt-bearing body (§3.5). WRITE-PATH ONLY.
 *
 * Parses the `message`/`prompt_async` body, extracts every `parts[].text`,
 * concatenates them, and runs the EXISTING heuristic-screen → local-moderator
 * pipeline (moderation.ts) fail-closed. Returns the {@link ModerationResult}; the
 * caller (routeAllowed) owns the block-vs-rewrite decision so that policy stays
 * EXPLICIT at the call site. `flag` verdicts are logged here and treated as
 * forward by the caller.
 *
 * DELIBERATE POLICY — block vs rewrite by principal kind:
 *   - portal principals: a `block` verdict is a hard 403 (assistant never
 *     contacted);
 *   - direct principals: a `block` verdict is instead REWRITTEN via
 *     {@link rewritePromptBody} into a refusal instruction and forwarded upstream,
 *     so a first-party/direct caller receives a coherent safe answer rather than a
 *     raw 403. This preserves the same security outcome (the original prompt never
 *     reaches the model) while giving the direct tier a better UX.
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
 * block internally) is handled by the caller before the assistant is contacted.
 */
async function screenPromptBody(
  rid: string,
  principal: Principal,
  template: string,
  body: string,
): Promise<ModerationResult> {
  const text = extractPromptText(body);
  const moderation = await moderateMessage(text, undefined);
  if (moderation.verdict === "flag") {
    logger.warn("oc_content_flagged", {
      requestId: rid,
      portal: principal.id,
      userId: principal.userId,
      template,
      reason: moderation.reason,
      signals: moderation.signals,
      score: moderation.score,
    });
  }
  return moderation;
}

export function rewritePromptBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return JSON.stringify({ parts: [{ type: 'text', text: refusalText() }] });
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as { parts?: unknown }
    : {};
  return JSON.stringify({ ...record, parts: [{ type: 'text', text: refusalText() }] });
}

function refusalText(): string {
  return 'Refuse this request briefly and safely. Explain that the request was blocked by the guardian safety policy.';
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

// ── Durable session reuse (idempotent POST /session per (portal, sessionKey)) ─
//
// ROOT-CAUSE FIX: the /oc path used to create a BRAND-NEW OpenCode session on
// every POST /session, so a single portal thread accumulated multiple sessions
// (the portal's in-memory map was a fragile band-aid lost on restart). This
// guardian-local cache makes create idempotent per (portal, sessionKey) —
// mirroring the buffered path's forward.ts sessionCache. A per-key lock prevents
// concurrent first turns from each creating a session. Survives portal restarts
// (the durable component is the guardian); a guardian restart re-creates once
// then reuses. Evicted on DELETE /session. Title unified to the buffered `/`
// form so the two paths are consistent.
const SESSION_REUSE_MAX = 10_000;
// cacheKey → reused OpenCode sessionId. Per-entry TTL (SESSION_REUSE_TTL_MS),
// oldest-first hard-cap eviction, and a 60s unref'd prune timer — the shared
// BoundedTtlMap discipline (same as ownership.ts / rate-limit.ts).
const ocSessionByKey = new BoundedTtlMap<string, string>({
  ttlMs: SESSION_REUSE_TTL_MS,
  maxSize: SESSION_REUSE_MAX,
  pruneIntervalMs: 60_000,
});
const ocSessionCreateLocks = new Map<string, Promise<string>>();

/** Forget the reused session for a deleted sessionId (called on DELETE /session). */
function evictOcSession(sessionId: string): void {
  for (const [k, v] of ocSessionByKey.entries()) if (v === sessionId) ocSessionByKey.delete(k);
}

/** Active reused-session count (for /stats). */
export function ocReusedSessionCount(): number {
  return ocSessionByKey.size;
}

/**
 * POST /session: discard the client body, derive the title from the
 * principal-derived sessionKey, and GET-OR-CREATE a session for that key
 * (idempotent — see ocSessionByKey above), then record sessionId→principal.
 */
async function forwardSessionCreate(
  req: Request,
  rid: string,
  principal: Principal,
  rawPath: string,
  search: string,
): Promise<Response> {
  // sessionKey rides as a header so multi-thread portals keep their grouping;
  // absent → falls back to userId inside resolveSessionTarget. The portal can
  // no longer inject an arbitrary title (prompt-injection / moderation-bypass).
  const sessionKey = req.headers.get(H_SESSION_KEY) ?? undefined;
  const metadata = sessionKey ? { sessionKey } : undefined;
  const target = resolveSessionTarget(principal.userId, principal.id, principal.kind, metadata);
  // cacheKey binds the full principal identity (kind+portal+userId) + sessionKey
  // so distinct users sharing a client-set sessionKey never collide. title is the
  // upstream OpenCode session title (may still collide across users) — the
  // ownership guard below refuses to reuse/rebind a foreign-owned match.
  const { cacheKey, title } = target;

  let inflight = ocSessionCreateLocks.get(cacheKey);
  if (!inflight) {
    inflight = (async (): Promise<string> => {
      // get(_, true) returns a live cached sessionId (refreshing its TTL) or
      // undefined if absent/expired. Refuse a cached id that some other principal
      // now owns (defence-in-depth) — mint a fresh session instead of stealing it.
      const cached = ocSessionByKey.get(cacheKey, true);
      if (cached !== undefined && !sessionOwnedByOther(cached, principal)) return cached;

      // Match by title can cross principals (same portal+sessionKey → same title);
      // never reuse/rebind a session already owned by a different principal.
      const existing = await findExistingOcSessionId(req, title);
      if (existing && !sessionOwnedByOther(existing, principal)) {
        ocSessionByKey.set(cacheKey, existing);
        return existing;
      }

      const rewritten = JSON.stringify({ title });
      const upstream = await fetchUpstream(req, rawPath, search, rewritten);
      const text = await upstream.text();
      if (!upstream.ok) throw new Error(`upstream_${upstream.status}:${text.slice(0, 200)}`);
      const parsed = JSON.parse(text) as { id?: unknown };
      const id = typeof parsed.id === "string" ? parsed.id : "";
      if (!id) throw new Error("upstream_no_id");
      ocSessionByKey.set(cacheKey, id);
      return id;
    })();
    ocSessionCreateLocks.set(cacheKey, inflight);
    void inflight.catch(() => {}).finally(() => {
      if (ocSessionCreateLocks.get(cacheKey) === inflight) ocSessionCreateLocks.delete(cacheKey);
    });
  }

  let sessionId: string;
  try {
    sessionId = await inflight;
  } catch (err) {
    logger.warn("oc_session_create_failed", { requestId: rid, portal: principal.id, userId: principal.userId, error: String(err) });
    return deny(rid, 502, "oc_session_create_failed", { principalId: principal.id, userId: principal.userId });
  }

  recordSessionOwner(sessionId, principal);
  audit({ requestId: rid, action: "oc_session_create", status: "ok", portal: principal.id, userId: principal.userId, sessionId });
  // Synthesize the create response the portal reads (it only needs id/title).
  return Response.json({ id: sessionId, title });
}

async function findExistingOcSessionId(req: Request, title: string): Promise<string | null> {
  const upstream = await fetch(`${ASSISTANT_URL}/session`, {
    method: 'GET',
    headers: buildUpstreamHeaders(req, false),
    signal: req.signal,
  });
  if (!upstream.ok) return null;

  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const match = parsed.find((session) => {
    if (!session || typeof session !== 'object') return false;
    return (session as { title?: unknown }).title === title;
  }) as { id?: unknown } | undefined;
  return typeof match?.id === 'string' && match.id ? match.id : null;
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
    logger.warn("oc_session_list_unparsable", { requestId: rid, portal: principal.id, userId: principal.userId });
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
  if (!pathOnly.startsWith(`${OC_PREFIX}/`)) return null;
  return pathOnly.slice(OC_PREFIX.length); // keep the leading "/"
}

function deny(rid: string, status: number, error: string, detail: Record<string, unknown>): Response {
  audit({ requestId: rid, action: "oc_proxy", status: status >= 500 ? "error" : "denied", reason: error, ...detail });
  logger.warn("oc_proxy_denied", { requestId: rid, status, error, ...detail });
  return json(status, { error, requestId: rid });
}
