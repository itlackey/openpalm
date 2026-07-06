/**
 * Guardian-LOCAL /event ownership filtering + fan-out (design §3.2, Stage 2).
 *
 * GET /event on the assistant multiplexes the OpenCode Event union for ALL
 * sessions of the instance. A byte-for-byte proxy would leak one principal's
 * tokens, tool output, and permission requests to another — a held-open
 * cross-tenant breach. So the guardian MUST parse the stream and forward only
 * frames whose `sessionID` the requesting principal owns.
 *
 * Design points implemented here:
 *   - ONE upstream subscription is held; filtered frames fan out to each
 *     connected principal stream, keyed by owned sessionIDs (§3.2 fan-out).
 *     Per-principal upstream subscription is the fallback, not used here.
 *   - Parse each SSE frame as { type, properties }. Read sessionID at
 *     event.properties.sessionID (for permission.asked, properties IS the
 *     PermissionRequest; its sessionID field reads the same way — §1.1).
 *   - HARD DROP RULE (§3.2 F2a): forward the RAW UNMODIFIED frame ONLY when
 *     sessionID is a non-empty string owned by the principal; otherwise DROP.
 *     Do NOT rely on Map.has(undefined). Global events (server.*, installation.*)
 *     carry no sessionID and thus never reach ANY principal — there is no owner
 *     to scope them to, so the safe default (drop) applies uniformly regardless
 *     of principal kind (rev3-F8: no direct-principal carve-out).
 *   - On permission.asked, record requestID→principal (ownership.ts) so a later
 *     POST /permission/{requestID}/reply can be authorized (§3.4).
 *   - Assistant restart mid-stream (§3.2, medium): if the upstream /event drops,
 *     broadcast a synthetic session.error to every open principal stream BEFORE
 *     attempting resubscribe.
 *   - Ignore unknown event types / tolerate added fields (graceful degrade, §5).
 *
 * This is guardian-local runtime state on purpose (mirrors rate-limit.ts /
 * ownership.ts) — NOT @openpalm/lib.
 */

import { createLogger } from './logger.ts';
import { TURN_IDLE_STATUSES, statusName } from './oc-events.ts';

import {
  type Principal,
  ownsSession,
  ownedSessionIds,
  recordPermissionOwner,
} from "./ownership";
import { endTurnsForSession } from "./oc-bounds";
import { runDriftCheck } from './drift';
import { ASSISTANT_URL } from './config';
import { parseSseFrames, extractData } from './sse.ts';

const logger = createLogger("guardian:event");

// ── A connected principal stream ───────────────────────────────────────────

interface Subscriber {
  principal: Principal;
  /** SSE bytes are pushed here; the proxy hands the readable side to the portal. */
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

// All connected principal streams. Multiple opens per principal are possible
// (the proxy enforces concurrency caps separately); each gets its own entry.
const subscribers = new Set<Subscriber>();

const encoder = new TextEncoder();

// Keepalive: the guardian drops upstream server.heartbeat frames (no sessionID,
// §3.2), so a turn whose model is quiet would send NO bytes to the portal for a
// long time. Emit an SSE comment (`: ping`) to every subscriber periodically so
// the held-open connection stays alive across intermediaries and half-open
// sockets are detected. Comments are ignored by SSE parsers (no event dispatched).
const KEEPALIVE_MS = Number(Bun.env.GUARDIAN_OC_EVENT_KEEPALIVE_MS ?? 20_000);
const keepaliveBytes = encoder.encode(`: ping\n\n`);
const keepaliveTimer = setInterval(() => {
  for (const sub of subscribers) writeTo(sub, keepaliveBytes);
}, KEEPALIVE_MS);
keepaliveTimer.unref();

// ── Single upstream subscription ───────────────────────────────────────────

let upstreamActive = false;
let upstreamAbort: AbortController | null = null;

/**
 * Pure SSE frame parser: read the `sessionID` an OpenCode event carries.
 *
 * Returns the sessionID ONLY when it is a non-empty string at
 * event.properties.sessionID; otherwise undefined (→ caller hard-drops).
 * Tolerates unknown event types and added fields (graceful degrade).
 */
export function frameSessionId(frameJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frameJson);
  } catch {
    return undefined;
  }
  const props = (parsed as { properties?: unknown })?.properties;
  if (!props || typeof props !== "object") return undefined;
  const sid = (props as { sessionID?: unknown }).sessionID;
  if (typeof sid !== "string" || sid.length === 0) return undefined;
  return sid;
}

/**
 * Pure: the event type name, or undefined. Used to detect permission.asked so
 * the guardian can record requestID→principal at relay time.
 */
function frameType(frameJson: string): string | undefined {
  try {
    const parsed = JSON.parse(frameJson) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure: the permission requestID from a permission.asked frame, where
 * properties IS the PermissionRequest and its `id` is the requestID (§1.2).
 */
function framePermissionRequestId(frameJson: string): string | undefined {
  try {
    const parsed = JSON.parse(frameJson) as { properties?: { id?: unknown } };
    const id = parsed.properties?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure: does this frame signal turn-end for its session? Uses the SAME idle
 * definition the portals use (isTurnEnd / TURN_IDLE_STATUSES from the portal runtime) so
 * the guardian's turn accounting and the portal's render agree on "turn over".
 */
function frameIsTurnEnd(frameJson: string): boolean {
  try {
    const parsed = JSON.parse(frameJson) as { type?: unknown; properties?: { status?: unknown } };
    if (parsed.type === "session.idle") return true;
    if (parsed.type === "session.status") {
      // status is `{type:"idle"}` on live 1.15.13 (or a bare string elsewhere).
      const name = statusName(parsed.properties?.status);
      return name !== undefined && TURN_IDLE_STATUSES.has(name);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Route ONE parsed SSE frame (raw JSON text) to the subscribers that own its
 * sessionID. Exported for unit tests (no upstream needed).
 *
 * - sessionID absent/null/empty → drop for EVERY principal, portal or direct
 *   (rev3-F8: a global frame has no owner to scope it to, so it is never
 *   broadcast — the same hard-drop rule applies uniformly).
 * - For each owning subscriber, write the RAW UNMODIFIED frame.
 * - On permission.asked, record requestID→principal for each owner so the reply
 *   gate can authorize it.
 * - On turn-end, release the in-flight-turn slot for the session (the async
 *   prompt_async turn closes at session-idle, not at HTTP return — oc-bounds).
 */
export function routeFrame(frameJson: string): void {
  const sessionId = frameSessionId(frameJson);
  // rev3-F8: a frame with no sessionID (server.*, installation.*) has no owner
  // to scope it to, so it is dropped for EVERY principal — portal AND direct.
  // There is no direct-principal carve-out: the HARD DROP RULE applies
  // uniformly, so a global broadcast never fans out to any stream.
  if (sessionId === undefined) return;

  // permission.asked AND question.asked both carry their reply id at
  // properties.id (per_… / que_…) and are answered by requestID; record
  // requestID→principal for either so the reply gate can authorize it (§3.4).
  const ft = frameType(frameJson);
  const interactiveRequestId =
    ft === "permission.asked" || ft === "question.asked" ? framePermissionRequestId(frameJson) : undefined;

  const sseBytes = encoder.encode(`data: ${frameJson}\n\n`);

  for (const sub of subscribers) {
    if (sub.closed) continue;
    if (!ownsSession(sessionId, sub.principal)) continue;
    if (interactiveRequestId) recordPermissionOwner(interactiveRequestId, sub.principal);
    writeTo(sub, sseBytes);
  }

  // Turn-end accounting is independent of whether a subscriber is connected:
  // the slot must be released so the in-flight cap and wall-clock sweep stay
  // meaningful for async turns (§3.6).
  if (frameIsTurnEnd(frameJson)) endTurnsForSession(sessionId);
}

function writeTo(sub: Subscriber, bytes: Uint8Array): void {
  if (sub.closed) return;
  try {
    sub.controller.enqueue(bytes);
  } catch {
    // Controller already closed/errored by the platform — drop the subscriber.
    dropSubscriber(sub);
  }
}

function dropSubscriber(sub: Subscriber): void {
  if (sub.closed) return;
  sub.closed = true;
  subscribers.delete(sub);
  try {
    sub.controller.close();
  } catch {
    // already closed
  }
}

/**
 * Broadcast a synthetic upstream-reset to EVERY open principal stream (§3.2): on
 * an assistant /event drop, portals must tear down orphaned interactive controls
 * (permission buttons whose requestID is now invalid).
 *
 * The frame MUST carry a `sessionID` the portal owns — the portal-side
 * `isSessionError(e, sessionId)` filters by `properties.sessionID`, so a
 * no-sessionID frame would be silently dropped and the teardown signal lost. We
 * therefore emit one session.error PER session each subscriber owns. A subscriber
 * that currently owns no session still gets a bare frame (harmless; nothing to
 * tear down) so the connection-level signal is not entirely swallowed.
 */
export function broadcastUpstreamReset(error: { name: string; message: string }): void {
  for (const sub of subscribers) {
    if (sub.closed) continue;
    const owned = ownedSessionIds(sub.principal);
    if (owned.size === 0) {
      writeTo(sub, encoder.encode(`data: ${JSON.stringify({ type: "session.error", properties: { error } })}\n\n`));
      continue;
    }
    for (const sessionID of owned) {
      const frame = JSON.stringify({ type: "session.error", properties: { sessionID, error } });
      writeTo(sub, encoder.encode(`data: ${frame}\n\n`));
    }
  }
}

/**
 * Parse a chunk of the upstream SSE byte stream, splitting on the blank-line
 * frame boundary, extracting the `data:` payload of each complete frame, and
 * routing it. Returns the unconsumed tail (a partial frame) to prepend next.
 *
 * Exported for unit tests.
 */
export function consumeSseBuffer(buffer: string): string {
  const { frames, rest } = parseSseFrames(buffer);
  for (const rawFrame of frames) {
    const dataPayload = extractData(rawFrame);
    if (dataPayload !== null) routeFrame(dataPayload);
  }
  return rest;
}

/**
 * Ensure the single upstream /event subscription is running. Idempotent — a
 * second caller while one is active is a no-op. On stream end/error it
 * broadcasts a synthetic session.error to all subscribers, then (if any remain)
 * schedules a resubscribe.
 */
function ensureUpstream(): void {
  if (upstreamActive) return;
  upstreamActive = true;
  void runUpstream();
}

async function runUpstream(): Promise<void> {
  const abort = new AbortController();
  upstreamAbort = abort;
  try {
    const headers = new Headers({ accept: "text/event-stream" });

    const resp = await fetch(`${ASSISTANT_URL}/event`, {
      method: "GET",
      headers,
      signal: abort.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`upstream /event status ${resp.status}`);
    }

    logger.info("event_upstream_open", {});
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBuffer(buffer);
    }
    logger.warn("event_upstream_closed", { reason: "stream_ended" });
  } catch (err) {
    if (abort.signal.aborted) {
      // We aborted deliberately (no subscribers left) — not an error.
      logger.info("event_upstream_aborted", {});
    } else {
      logger.error("event_upstream_error", { error: String(err) });
    }
  } finally {
    upstreamActive = false;
    upstreamAbort = null;
    // Assistant restart mid-stream: tell every open portal BEFORE resubscribe
    // so they tear down orphaned interactive controls (permission buttons whose
    // requestID is now invalid). A bare synthetic frame; portals surface it.
    if (subscribers.size > 0) {
      broadcastUpstreamReset({ name: "GuardianUpstreamReset", message: "assistant event stream reset" });
      // Brief backoff before re-establishing the single upstream subscription.
      setTimeout(() => {
        if (subscribers.size > 0) {
          void runDriftCheck().then((enabled) => {
            if (enabled && subscribers.size > 0) ensureUpstream();
          });
        }
      }, 1_000).unref();
    }
  }
}

// ── Public API: open a filtered /event stream for a principal ──────────────

/**
 * Open a filtered SSE stream for `principal`. Returns a Response whose body is a
 * ReadableStream of `data: <frame>\n\n` lines — only frames for sessions the
 * principal owns. The single upstream subscription is started on first open.
 *
 * The client abort signal (portal disconnect) tears down this subscriber; when
 * the last subscriber leaves, the upstream subscription is aborted.
 */
export function openEventStream(principal: Principal, clientSignal: AbortSignal): Response {
  let sub: Subscriber;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sub = { principal, controller, closed: false };
      subscribers.add(sub);
      // Flush headers immediately with an SSE comment so the portal sees an
      // open 200 stream without waiting for the first owned frame (an empty
      // event-stream otherwise buffers headers until first byte).
      try {
        controller.enqueue(encoder.encode(": open\n\n"));
      } catch {
        // controller already closed — drop below
      }
      ensureUpstream();
      const onAbort = () => dropSubscriber(sub);
      if (clientSignal.aborted) onAbort();
      else clientSignal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      dropSubscriber(sub);
      maybeStopUpstream();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

function maybeStopUpstream(): void {
  if (subscribers.size === 0 && upstreamAbort) {
    upstreamAbort.abort();
  }
}

// ── /stats + test helpers ──────────────────────────────────────────────────

/** Number of currently-connected filtered /event subscribers (for /stats). */
export function eventSubscriberCount(): number {
  return subscribers.size;
}

/** Test-only: register a subscriber with an externally-driven controller. */
export function _addTestSubscriber(principal: Principal, controller: ReadableStreamDefaultController<Uint8Array>): { drop: () => void } {
  const sub: Subscriber = { principal, controller, closed: false };
  subscribers.add(sub);
  return { drop: () => dropSubscriber(sub) };
}

/** Test-only: clear all subscribers between cases. */
export function _resetSubscribersForTest(): void {
  for (const sub of [...subscribers]) dropSubscriber(sub);
  subscribers.clear();
}
