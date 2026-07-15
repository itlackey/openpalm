/**
 * Guardian /oc/event — per-connection native-preserving SSE relay with tenant
 * filtering (design §3.2).
 *
 * GET /event on the assistant multiplexes the OpenCode Event union for ALL
 * sessions of the instance. A byte-for-byte proxy would leak one principal's
 * tokens, tool output, and permission requests to another. So the guardian parses
 * the stream and forwards only frames whose `sessionID` the requesting principal
 * owns — but it forwards those frames VERBATIM (id:/event:/data: lines intact) so
 * OpenCode's native framing and `Last-Event-ID` resume survive.
 *
 * TRANSPARENT model (replaces the old single shared upstream subscription): each
 * client /event connection opens its OWN upstream /event subscription, forwarding
 * the client's query string (directory scope) and `Last-Event-ID` header so resume
 * is exact and per-connection. The guardian never rewrites frame schema — it only
 * DROPS frames the principal does not own.
 *
 * Filtering rules (unchanged security posture):
 *   - A frame with a non-empty `properties.sessionID` owned by the principal →
 *     forwarded verbatim.
 *   - A frame the principal does not own → dropped.
 *   - A frame with no sessionID (server.*, installation.*, heartbeat) → dropped for
 *     EVERY principal: it has no owner to scope it to (rev3-F8, tenant isolation).
 *   - On `permission.asked` / `question.asked` for an owned session, record
 *     requestID→principal so the reply gate can authorize it (§3.4).
 *
 * This is guardian-local runtime state on purpose — NOT @openpalm/lib.
 */

import { createLogger } from './logger.ts';

import { type Principal, ownsSession, ownedSessionIds, principalKey, recordPermissionOwner } from './ownership';
import { ASSISTANT_URL, withAssistantUpstreamAuth } from './config';
import { parseSseFrames, extractData } from './sse.ts';

const logger = createLogger('guardian:event');

// ── A connected principal relay ─────────────────────────────────────────────

interface Subscriber {
	principal: Principal;
	controller: ReadableStreamDefaultController<Uint8Array>;
	closed: boolean;
}

// All connected principal relays (for the concurrency cap + keepalive sweep).
const subscribers = new Set<Subscriber>();
export const EVENT_MAX_STREAMS_PER_PRINCIPAL = 2;
export const EVENT_MAX_SUBSCRIBERS = 1_024;
export const EVENT_SUBSCRIBER_BUFFER_BYTES = 256 * 1_024;

export function canOpenEventStream(principal: Principal): boolean {
	if (subscribers.size >= EVENT_MAX_SUBSCRIBERS) return false;
	const key = principalKey(principal);
	let count = 0;
	for (const sub of subscribers) {
		if (principalKey(sub.principal) !== key) continue;
		count += 1;
		if (count >= EVENT_MAX_STREAMS_PER_PRINCIPAL) return false;
	}
	return true;
}

const encoder = new TextEncoder();

// Keepalive: the guardian drops upstream no-sessionID heartbeat frames (§3.2), so
// a turn whose model is quiet would send NO bytes to the client for a long time.
// Emit an SSE comment (`: ping`) to every relay periodically so the held-open
// connection stays alive across intermediaries and half-open sockets are detected.
const KEEPALIVE_MS = Number(Bun.env.GUARDIAN_OC_EVENT_KEEPALIVE_MS ?? 20_000);
const keepaliveBytes = encoder.encode(`: ping\n\n`);
const keepaliveTimer = setInterval(() => {
	for (const sub of subscribers) writeTo(sub, keepaliveBytes);
}, KEEPALIVE_MS);
keepaliveTimer.unref();

// ── Pure frame inspection (exported for unit tests; no upstream needed) ───────

/**
 * The `sessionID` an OpenCode event carries, ONLY when it is a non-empty string at
 * event.properties.sessionID; otherwise undefined (→ caller drops). Tolerates
 * unknown event types and added fields (graceful degrade).
 */
export function frameSessionId(frameJson: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(frameJson);
	} catch {
		return undefined;
	}
	const props = (parsed as { properties?: unknown })?.properties;
	if (!props || typeof props !== 'object') return undefined;
	const sid = (props as { sessionID?: unknown }).sessionID;
	if (typeof sid !== 'string' || sid.length === 0) return undefined;
	return sid;
}

/** The event type name, or undefined. */
export function frameType(frameJson: string): string | undefined {
	try {
		const parsed = JSON.parse(frameJson) as { type?: unknown };
		return typeof parsed.type === 'string' ? parsed.type : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The permission/question requestID from a permission.asked / question.asked
 * frame, where properties IS the request and its `id` is the requestID (§1.2).
 */
export function framePermissionRequestId(frameJson: string): string | undefined {
	try {
		const parsed = JSON.parse(frameJson) as { properties?: { id?: unknown } };
		const id = parsed.properties?.id;
		return typeof id === 'string' && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

// ── Per-connection relay ─────────────────────────────────────────────────────

function writeTo(sub: Subscriber, bytes: Uint8Array): void {
	if (sub.closed) return;
	try {
		const desiredSize = sub.controller.desiredSize;
		if (typeof desiredSize === 'number' && bytes.byteLength > desiredSize) {
			dropSubscriber(sub);
			return;
		}
		sub.controller.enqueue(bytes);
	} catch {
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
 * Relay one COMPLETE upstream SSE frame (content, separator stripped) to `sub` if
 * the principal owns it. Forwards the frame VERBATIM (all lines preserved) so
 * OpenCode's native framing + `id:` (Last-Event-ID) survive. Records permission
 * ownership for owned permission.asked/question.asked frames.
 */
function relayFrame(sub: Subscriber, frameContent: string): void {
	const payload = extractData(frameContent);
	// Comment / keepalive frames (no data:) carry nothing tenant-scoped; the
	// guardian emits its own keepalive, so upstream comments are simply dropped.
	if (payload === null) return;

	const sessionId = frameSessionId(payload);
	// No sessionID (server.*, installation.*, heartbeat) → no owner to scope it to
	// → dropped for every principal (tenant isolation, rev3-F8).
	if (sessionId === undefined) return;
	if (!ownsSession(sessionId, sub.principal)) return;

	const ft = frameType(payload);
	if (ft === 'permission.asked' || ft === 'question.asked') {
		const requestId = framePermissionRequestId(payload);
		if (requestId) recordPermissionOwner(requestId, sub.principal);
	}

	// Verbatim re-emit: the original frame lines + a blank-line terminator.
	writeTo(sub, encoder.encode(`${frameContent}\n\n`));
}

/**
 * Emit a synthetic session.error to the relay for every session the principal
 * owns (§3.2): on an upstream /event drop, clients must tear down orphaned
 * interactive controls (permission buttons whose requestID is now invalid). A
 * client with no owned session gets one bare frame so the connection-level signal
 * is not entirely swallowed.
 */
function emitUpstreamReset(sub: Subscriber, error: { name: string; message: string }): void {
	if (sub.closed) return;
	const owned = ownedSessionIds(sub.principal);
	if (owned.size === 0) {
		writeTo(sub, encoder.encode(`data: ${JSON.stringify({ type: 'session.error', properties: { error } })}\n\n`));
		return;
	}
	for (const sessionID of owned) {
		const frame = JSON.stringify({ type: 'session.error', properties: { sessionID, error } });
		writeTo(sub, encoder.encode(`data: ${frame}\n\n`));
	}
}

/**
 * Pump this connection's own upstream /event subscription, filtering + relaying
 * owned frames until the client disconnects or the upstream ends.
 */
async function pumpUpstream(sub: Subscriber, req: Request): Promise<void> {
	const clientUrl = new URL(req.url);
	const headers = withAssistantUpstreamAuth(new Headers({ accept: 'text/event-stream' }));
	// Forward Last-Event-ID (exact resume) — the client's, not a shared cursor.
	const lastEventId = req.headers.get('last-event-id');
	if (lastEventId) headers.set('last-event-id', lastEventId);

	try {
		// Forward the client's query string (directory scope etc.) verbatim.
		const resp = await fetch(`${ASSISTANT_URL}/event${clientUrl.search}`, {
			method: 'GET',
			headers,
			signal: req.signal,
		});
		if (!resp.ok || !resp.body) throw new Error(`upstream /event status ${resp.status}`);

		logger.info('event_upstream_open', {});
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { frames, rest } = parseSseFrames(buffer);
			buffer = rest;
			for (const frameContent of frames) relayFrame(sub, frameContent);
			if (sub.closed) break;
		}
		logger.warn('event_upstream_closed', { reason: 'stream_ended' });
	} catch (err) {
		if (req.signal.aborted) {
			logger.info('event_upstream_aborted', {});
			return;
		}
		logger.error('event_upstream_error', { error: String(err) });
	} finally {
		if (!sub.closed && !req.signal.aborted) {
			// Upstream ended/reset (assistant restart): signal teardown, then close so
			// the client's EventSource reconnects (with its Last-Event-ID) on its own.
			emitUpstreamReset(sub, { name: 'GuardianUpstreamReset', message: 'assistant event stream reset' });
			dropSubscriber(sub);
		}
	}
}

// ── Public API: open a filtered /event stream for a principal ──────────────

/**
 * Open a filtered SSE stream for `principal`. Returns a Response whose body is a
 * ReadableStream of the OpenCode frames — VERBATIM — for sessions the principal
 * owns. This connection holds its own upstream /event subscription; the client
 * abort signal (disconnect) tears both down.
 */
export function openEventStream(principal: Principal, req: Request): Response {
	let sub: Subscriber;
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				sub = { principal, controller, closed: false };
				subscribers.add(sub);
				// Flush headers immediately with an SSE comment so the client sees an
				// open 200 stream without waiting for the first owned frame.
				try {
					controller.enqueue(encoder.encode(': open\n\n'));
				} catch {
					// controller already closed — drop below
				}
				const onAbort = () => dropSubscriber(sub);
				if (req.signal.aborted) onAbort();
				else req.signal.addEventListener('abort', onAbort, { once: true });
				void pumpUpstream(sub, req);
			},
			cancel() {
				dropSubscriber(sub);
			},
		},
		{
			highWaterMark: EVENT_SUBSCRIBER_BUFFER_BYTES,
			size: (chunk) => chunk.byteLength,
		},
	);

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
		},
	});
}

// ── /stats + test helpers ──────────────────────────────────────────────────

/** Number of currently-connected filtered /event relays (for /stats). */
export function eventSubscriberCount(): number {
	return subscribers.size;
}

/** Test-only: drop all relays between cases. */
export function _resetSubscribersForTest(): void {
	for (const sub of [...subscribers]) dropSubscriber(sub);
	subscribers.clear();
}
