/**
 * Guardian /oc/* reverse proxy — TRANSPARENT native OpenCode passthrough with
 * security-policy overlays.
 *
 * The guardian forwards EVERY OpenCode method/path/query/body untouched (native
 * passthrough — the UI-proxy pattern: stream `upstream.body`, never buffer a
 * response) and layers the fail-closed policies on top as OVERLAYS on the handful
 * of paths that carry tenant state — never a second protocol, never an allowlist:
 *
 *   1. Per-call Basic auth + user identity binding (auth.ts).
 *   2. Rate limiting (rate-limit.ts).
 *   3. Path safety — percent-decode + `..` traversal refusal (oc-path.ts). Not an
 *      authorization gate; just proxy hygiene so the guardian and OpenCode agree
 *      on the path.
 *   4. Session-ownership authz (ownership.ts, persisted in SQLite): POST /session
 *      records `sessionId→principal` from the NATIVE response; every /session/{id}
 *      call and GET /session listing is scoped to the principal's own sessions.
 *   5. Permission/question-reply ownership: the /event relay records
 *      requestID→principal; a reply is authorized against that record.
 *   6. Content moderation of the two prompt-bearing writes (message / prompt_async)
 *      — fail-closed (moderation.ts). WRITE-PATH ONLY; responses are never screened.
 *
 * Everything else — /provider, /config, /app, /doc, /find, GET /session/{id}/message
 * history, and any endpoint OpenCode adds later — forwards transparently.
 */

import { canonicalizeOcPath, classifyOcRoute } from './oc-path.ts';
import { createLogger } from './logger.ts';

import { json } from './http-util.ts';
import { authenticate } from './auth';
import {
	type Principal,
	ownsSession,
	ownsPermission,
	recordSessionOwner,
	forgetSession,
	ownedSessionIds,
	touchSessionOwner,
} from './ownership';
import { canOpenEventStream, openEventStream } from './event-fanout';
import { audit } from './audit';
import { moderateMessage, type ModerationResult } from './moderation';
import { ASSISTANT_URL, readPositiveIntEnv, withAssistantUpstreamAuth } from './config';
import {
	allow,
	allowPreAuth,
	PORTAL_RATE_LIMIT,
	PORTAL_RATE_WINDOW_MS,
	USER_RATE_LIMIT,
	USER_RATE_WINDOW_MS,
} from './rate-limit.ts';

const logger = createLogger('guardian:proxy');

// ── Config ──────────────────────────────────────────────────────────────

/** Base path under which the native OpenCode proxy is served. */
export const OC_PREFIX = '/oc';

const OC_MAX_BODY_BYTES = readPositiveIntEnv('GUARDIAN_OC_MAX_BODY_BYTES', 1_048_576); // 1 MiB

// Hop-by-hop headers (RFC 7230 §6.1) plus host/content-length: never forwarded in
// either direction — they describe THIS connection, not the end-to-end message, and
// the platform (Bun) sets host/content-length/transfer-encoding itself.
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'transfer-encoding',
	'upgrade',
	'proxy-authorization',
	'proxy-authenticate',
	'te',
	'trailer',
	'host',
	'content-length',
]);

// Inbound-only headers stripped before forwarding upstream: the guardian's own
// Basic credentials and its routing hints must never leak to the assistant. The
// upstream Basic auth (the assistant always requires it) is injected
// server-side instead, via withAssistantUpstreamAuth.
const STRIP_INBOUND = new Set(['authorization', 'x-openpalm-user', 'x-openpalm-session-key']);

// ── Header construction ─────────────────────────────────────────────────────

/**
 * Forward the client's end-to-end request headers, stripping hop-by-hop headers +
 * the guardian's inbound creds/hints, then inject the guardian→assistant upstream
 * auth (always attached). This is a strip-list model (transparent)
 * — not the old fresh-minimal allowlist.
 */
function buildUpstreamHeaders(req: Request): Headers {
	const headers = new Headers();
	for (const [name, value] of req.headers) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || STRIP_INBOUND.has(lower)) continue;
		headers.set(name, value);
	}
	// #563 D2 — attach guardian→assistant upstream Basic auth when the assistant's
	// own OpenCode auth is on. No-op (never forwards inbound auth) by default.
	return withAssistantUpstreamAuth(headers);
}

/**
 * Forward the upstream response headers verbatim, stripping hop-by-hop headers +
 * a diagnostic request id. Streaming-relevant headers (content-type, cache-control)
 * survive because they are end-to-end, not hop-by-hop.
 */
function buildResponseHeaders(upstream: Response, rid: string): Headers {
	const headers = new Headers();
	for (const [name, value] of upstream.headers) {
		if (HOP_BY_HOP.has(name.toLowerCase())) continue;
		headers.set(name, value);
	}
	if (!headers.has('content-type')) headers.set('content-type', 'application/json');
	headers.set('x-request-id', rid);
	return headers;
}

// ── Main handler ───────────────────────────────────────────────────────────

/**
 * Handle a /oc/* request. The caller (server.ts) has already matched the pathname
 * prefix; `req` is the full request and `rid` the request id.
 */
export async function handleProxy(
	req: Request,
	rid: string,
	expectedKind?: 'portal' | 'direct',
	clientIp = '',
): Promise<Response> {
	const url = new URL(req.url);

	// The OpenCode path is everything after the /oc prefix. Use the RAW encoded
	// pathname so canonicalizeOcPath can decode/traversal-check it itself.
	const rawPath = rawOcPath(req.url);
	if (rawPath === null) {
		return deny(rid, 404, 'not_found', { reason: 'no_oc_prefix' });
	}

	const method = req.method;

	if (!allowPreAuth(clientIp)) {
		return deny(rid, 429, 'rate_limited', { reason: 'preauth_ip' });
	}

	const authenticated = await authenticate(req, expectedKind);
	if (!authenticated) {
		return deny(rid, 401, 'unauthorized', {});
	}

	if (
		!allow(`portal:oc:${authenticated.kind}:${authenticated.id}`, PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS) ||
		!allow(
			`user:oc:${authenticated.kind}:${authenticated.id}:${authenticated.userId}`,
			USER_RATE_LIMIT,
			USER_RATE_WINDOW_MS,
		)
	) {
		return deny(rid, 429, 'rate_limited', {
			principalId: authenticated.id,
			userId: authenticated.userId,
		});
	}

	// ── Path safety (proxy hygiene, not authorization) ────────────────────────
	const safe = canonicalizeOcPath(rawPath);
	if (!safe.ok) {
		return deny(rid, 400, 'bad_request', {
			principalId: authenticated.id,
			userId: authenticated.userId,
			method,
			path: rawPath,
			reason: safe.reason,
		});
	}
	const path = safe.path;

	// ── Read the body (bounded) after authenticate() ──────────────────────────
	let body = '';
	if (method !== 'GET' && method !== 'HEAD') {
		const boundedBody = await readBoundedBody(req, OC_MAX_BODY_BYTES);
		if (!boundedBody.ok) {
			return deny(rid, 413, 'payload_too_large', { bodyLength: boundedBody.bodyLength });
		}
		body = boundedBody.body;
	}

	const principal: Principal = {
		id: authenticated.id,
		kind: authenticated.kind,
		userId: authenticated.userId,
	};

	return await routeRequest(req, rid, principal, method, path, url.search, body);
}

async function readBoundedBody(
	req: Request,
	maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; bodyLength: number }> {
	const declaredLength = Number(req.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		return { ok: false, bodyLength: declaredLength };
	}
	if (!req.body) return { ok: true, body: '' };

	const reader = req.body.getReader();
	const decoder = new TextDecoder();
	let body = '';
	let bodyLength = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bodyLength += value.byteLength;
		if (bodyLength > maxBytes) {
			await reader.cancel();
			return { ok: false, bodyLength };
		}
		body += decoder.decode(value, { stream: true });
	}
	body += decoder.decode();
	return { ok: true, body };
}

/**
 * Apply the policy overlay for the classified route, then forward. Default is
 * transparent passthrough; only the recognised tenant-scoped paths gate.
 */
async function routeRequest(
	req: Request,
	rid: string,
	principal: Principal,
	method: string,
	path: string,
	search: string,
	body: string,
): Promise<Response> {
	const route = classifyOcRoute(method, path);

	switch (route.kind) {
		// GET /event — per-connection filtered relay. A byte-for-byte passthrough
		// would cross-leak other principals' frames (§3.2); the relay forwards only
		// owned frames (verbatim, Last-Event-ID preserved) and records permission
		// ownership.
		case 'event': {
			if (!canOpenEventStream(principal)) {
				return deny(rid, 429, 'too_many_event_streams', {
					principalId: principal.id,
					userId: principal.userId,
				});
			}
			audit({ requestId: rid, action: 'oc_event_open', status: 'ok', portal: principal.id, userId: principal.userId });
			return openEventStream(principal, req);
		}

		// POST /session — forward the NATIVE body, return the NATIVE response, and
		// record sessionId→principal from a buffered success so the /event creation
		// race is closed before the response reaches the client.
		case 'session-create':
			return await forwardSessionCreate(req, rid, principal, path, search, body);

		// GET /session — filter the returned array to the principal's own sessions
		// so other principals' titles never leak (§3.4).
		case 'session-list':
			return await forwardSessionList(req, rid, principal, path, search, body);

		// POST /permission/{requestID}/reply — own requestID only (§3.4). The /event
		// relay records requestID→principal when it forwards permission.asked, so
		// only the principal shown the request can answer it; fail-closed otherwise.
		case 'permission-reply': {
			if (!ownsPermission(route.requestId, principal)) {
				return deny(rid, 403, 'forbidden_permission', {
					principalId: principal.id,
					userId: principal.userId,
					requestID: route.requestId,
				});
			}
			return await forwardTransparent(req, rid, path, search, body);
		}

		// POST /question/{requestID}/(reply|reject) — the parallel of permission
		// reply, same ownership model (ownsPermission covers per_ and que_ ids).
		case 'question-reply': {
			if (!ownsPermission(route.requestId, principal)) {
				return deny(rid, 403, 'forbidden_question', {
					principalId: principal.id,
					userId: principal.userId,
					requestID: route.requestId,
				});
			}
			return await forwardTransparent(req, rid, path, search, body);
		}

		// /session/{id}[/...] — assert ownership of {id}, then moderate the two
		// prompt-bearing writes and forget ownership on a successful DELETE.
		case 'session-scoped': {
			if (!ownsSession(route.sessionId, principal)) {
				return deny(rid, 403, 'forbidden_session', {
					principalId: principal.id,
					userId: principal.userId,
					sessionId: route.sessionId,
				});
			}
			// S4 Fix A (#586): refresh last_used_at on every authorized
			// session-scoped request (message/prompt_async/abort/history/DELETE)
			// so a session actually in use is never picked as an idle eviction
			// candidate. Deliberately NOT called in event-fanout.ts (per-frame hot
			// path; frames only flow for sessions already driven by a touched
			// request here).
			touchSessionOwner(route.sessionId);

			if (route.moderatedWrite) {
				// Gate 6: content moderation — WRITE-PATH ONLY (§3.5). Screen the prompt,
				// then apply block-vs-rewrite by principal kind at the call site:
				//   - portal principals → hard 403 (assistant never contacted);
				//   - direct principals → prompt REWRITE into a refusal, forwarded so the
				//     caller gets a safe answer rather than a raw error.
				const moderation = await screenPromptBody(rid, principal, path, body);
				let promptBody = body;
				if (moderation.verdict === 'block') {
					if (principal.kind === 'direct') {
						promptBody = rewritePromptBody(body);
					} else {
						return deny(rid, 403, 'content_blocked', {
							principalId: principal.id,
							userId: principal.userId,
							path,
							source: moderation.source,
							reason: moderation.reason,
							signals: moderation.signals,
							score: moderation.score,
						});
					}
				}
				return await forwardTransparent(req, rid, path, search, promptBody);
			}

			if (route.sessionDelete) {
				const resp = await forwardTransparent(req, rid, path, search, body);
				if (resp.ok) forgetSession(route.sessionId);
				return resp;
			}

			return await forwardTransparent(req, rid, path, search, body);
		}

		// Every other OpenCode endpoint (/provider, /config, /app, /doc, /find,
		// GET /session/{id}/message history, …) forwards transparently.
		default:
			return await forwardTransparent(req, rid, path, search, body);
	}
}

/**
 * Gate 6 — content moderation of a prompt-bearing body (§3.5). WRITE-PATH ONLY.
 *
 * Parses the `message`/`prompt_async` body, extracts every `parts[].text` PLUS
 * the optional `system` field, concatenates them, and runs the heuristic-screen →
 * local-moderator pipeline (moderation.ts) fail-closed. The caller owns the
 * block-vs-rewrite decision so policy stays explicit at the call site; `flag`
 * verdicts are logged here and treated as forward by the caller.
 *
 * ── OPENCODE REQUEST-BODY SCHEMA COUPLING — pinned to OPENCODE_VERSION ──
 * This is the SINGLE place the proxy reaches inside an OpenCode request body. The
 * shape is `{ parts: [{ type: "text", text: string }, …], system?: string, … }` for
 * both POST /session/{id}/message and prompt_async — `parts[].text` and `system`
 * are the only free-text fields; the rest are routing values. Keep this isolated
 * and update in lockstep with OPENCODE_VERSION if OpenCode changes the shape.
 * Fail-closed: an unparseable body screens as "" (moderation allows empty), so the
 * upstream still validates the real shape; a `block` verdict is handled by the
 * caller before the assistant is contacted.
 */
async function screenPromptBody(
	rid: string,
	principal: Principal,
	path: string,
	body: string,
): Promise<ModerationResult> {
	const text = extractPromptText(body);
	const moderation = await moderateMessage(text, undefined);
	if (moderation.verdict === 'flag') {
		logger.warn('oc_content_flagged', {
			requestId: rid,
			portal: principal.id,
			userId: principal.userId,
			path,
			reason: moderation.reason,
			signals: moderation.signals,
			score: moderation.score,
		});
	}
	return moderation;
}

// rev3-F5: only these fields may survive a moderation-block rewrite. Each is a
// routing/selection value (which model/agent to use, an idempotency id, a
// reply-suppression flag) — never free text that could carry an instruction.
const REWRITE_SAFE_FIELDS = ['messageID', 'model', 'agent', 'noReply'] as const;

export function rewritePromptBody(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return JSON.stringify({ parts: [{ type: 'text', text: refusalText() }] });
	}
	const record =
		parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	const safe: Record<string, unknown> = {};
	for (const field of REWRITE_SAFE_FIELDS) {
		if (record[field] !== undefined) safe[field] = record[field];
	}
	return JSON.stringify({ ...safe, parts: [{ type: 'text', text: refusalText() }] });
}

function refusalText(): string {
	return 'Refuse this request briefly and safely. Explain that the request was blocked by the guardian safety policy.';
}

/**
 * Extract and concatenate the text of every `parts[].text` entry AND the optional
 * `system` field from a message/prompt_async body. Returns "" for any body that is
 * not the pinned OpenCode shape (see the schema-coupling note on screenPromptBody).
 */
function extractPromptText(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return '';
	}
	const record = parsed as { parts?: unknown; system?: unknown } | null;
	const texts: string[] = [];
	if (typeof record?.system === 'string' && record.system) texts.push(record.system);
	const parts = record?.parts;
	if (!Array.isArray(parts)) return texts.join('\n');
	for (const part of parts) {
		const t = (part as { text?: unknown })?.text;
		if (typeof t === 'string' && t) texts.push(t);
	}
	return texts.join('\n');
}

/**
 * POST /session: forward the NATIVE request body, return the NATIVE OpenCode
 * response, and record sessionId→principal from a BUFFERED success (the create
 * response is small JSON — buffering it lets ownership be recorded synchronously,
 * closing the /event creation race, before the client sees the response). No body
 * rewrite, no synthesized shape, no server-side session-reuse cache.
 */
async function forwardSessionCreate(
	req: Request,
	rid: string,
	principal: Principal,
	path: string,
	search: string,
	body: string,
): Promise<Response> {
	const upstream = await fetchUpstream(req, path, search, body);
	const text = await upstream.text();
	if (upstream.ok) {
		try {
			const parsed = JSON.parse(text) as { id?: unknown };
			if (typeof parsed.id === 'string' && parsed.id) {
				recordSessionOwner(parsed.id, principal);
				audit({
					requestId: rid,
					action: 'oc_session_create',
					status: 'ok',
					portal: principal.id,
					userId: principal.userId,
					sessionId: parsed.id,
				});
			}
		} catch {
			// Non-JSON success body — nothing to own; still forward it verbatim.
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
	path: string,
	search: string,
	body: string,
): Promise<Response> {
	const upstream = await fetchUpstream(req, path, search, body);
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
				return typeof id === 'string' && owned.has(id);
			});
		}
	} catch {
		logger.warn('oc_session_list_unparsable', {
			requestId: rid,
			portal: principal.id,
			userId: principal.userId,
		});
		filtered = [];
	}
	return json(upstream.status, filtered);
}

/**
 * Transparent passthrough with streaming body — the UI-proxy precedent. Returns
 * `upstream.body` UNTOUCHED (never .text()/.json() — that would buffer SSE in
 * memory and break streaming). Status + end-to-end headers copied.
 */
async function forwardTransparent(
	req: Request,
	rid: string,
	path: string,
	search: string,
	body: string,
): Promise<Response> {
	const upstream = await fetchUpstream(req, path, search, body);
	return new Response(upstream.body, {
		status: upstream.status,
		headers: buildResponseHeaders(upstream, rid),
	});
}

/**
 * Issue the upstream fetch to the assistant OpenCode server. Wires the client's
 * abort signal to the upstream fetch (no fixed timeout — SSE streams run for
 * minutes; rely on client disconnect for teardown), mirroring the UI proxy.
 */
function fetchUpstream(req: Request, path: string, search: string, body: string | undefined): Promise<Response> {
	const targetUrl = `${ASSISTANT_URL}${path}${search}`;
	const method = req.method;
	const hasBody = method !== 'GET' && method !== 'HEAD';

	const controller = new AbortController();
	const onClientAbort = () => controller.abort();
	req.signal.addEventListener('abort', onClientAbort, { once: true });

	return fetch(targetUrl, {
		method,
		headers: buildUpstreamHeaders(req),
		body: hasBody ? (body ?? '') : undefined,
		signal: controller.signal,
	});
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the RAW (still percent-encoded) OpenCode path from a request URL whose
 * pathname begins with `${OC_PREFIX}/`. Returns the path WITHOUT the /oc prefix
 * and WITHOUT the query string, or null if the prefix is absent.
 */
function rawOcPath(rawUrl: string): string | null {
	const noScheme = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
	const pathOnly = noScheme.split('?')[0].split('#')[0];
	if (pathOnly === OC_PREFIX) return '/'; // "/oc" alone → "/"
	if (!pathOnly.startsWith(`${OC_PREFIX}/`)) return null;
	return pathOnly.slice(OC_PREFIX.length); // keep the leading "/"
}

function deny(rid: string, status: number, error: string, detail: Record<string, unknown>): Response {
	audit({
		requestId: rid,
		action: 'oc_proxy',
		status: status >= 500 ? 'error' : 'denied',
		reason: error,
		...detail,
	});
	logger.warn('oc_proxy_denied', { requestId: rid, status, error, ...detail });
	return json(status, { error, requestId: rid });
}
