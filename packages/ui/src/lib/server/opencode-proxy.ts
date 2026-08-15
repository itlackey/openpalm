/**
 * The one server-side hop from this process to its OpenCode.
 *
 * Two routes make it: `/oc/*` (the OpenCode **API**, which the browser's chat
 * transport calls) and `/_opencode/*` (the OpenCode **web UI**, which
 * `/advanced` frames). They differ only in what they do with the response —
 * `/_opencode` rewrites the HTML document, `/oc` streams everything through
 * untouched — so the request half (auth, header hygiene, abort forwarding,
 * upstream resolution) lives here rather than being written twice.
 *
 * Upstream resolution is `getAssistantOpencodeTarget()` — the same resolver
 * every other server route uses — so ONE code path serves both topologies:
 *   - container co-process: `OP_OPENCODE_URL=http://localhost:4096`, set by
 *     the assistant entrypoint;
 *   - host process (`openpalm app` / `admin` / Electron): the env-derived
 *     `127.0.0.1:${OP_ASSISTANT_PORT}`.
 *
 * Basic auth for the upstream is attached HERE, server-side, from the same
 * resolver, so the browser never sees an OpenCode credential.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { errorResponse } from './helpers.js';
import { assistantAuthHeaders } from './basic-auth.js';
import { getAssistantOpencodeTarget } from './opencode-target.js';

/**
 * NO upstream timeout, deliberately.
 *
 * This carried a 30s header-arrival timeout on the theory that headers always
 * arrive quickly and only bodies stream. That is false for the one request
 * that matters most: OpenCode's `POST /session/:id/message` returns its
 * headers when the TURN COMPLETES, so every chat turn longer than 30s — tool
 * use, long reasoning, a slow local model — was aborted and surfaced as
 * `502 assistant_unreachable`, on the locked default connection of every
 * install. The client's own budget is 150s.
 *
 * Nothing is lost by removing it. The upstream is loopback in every topology
 * (host process → published assistant port; container co-process →
 * `localhost:4096`), so an absent server fails immediately with ECONNREFUSED
 * rather than hanging. What must stay is the CLIENT's abort, forwarded below:
 * without it every `/oc/event` reconnect would leak an upstream subscription
 * OpenCode keeps alive for a browser that is gone.
 */

/** Hop-by-hop and length headers that must not be forwarded in either direction. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  // Never forward the browser's cookie to OpenCode: it is this app's session,
  // not an upstream credential, and OpenCode has no use for it.
  'cookie',
  // Replaced with the resolved upstream credential below, if any.
  'authorization',
  // Recomputed by fetch from the buffered body.
  'content-length',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'trailer',
  // Deliberately dropped: node's fetch transparently decompresses a gzip/br
  // upstream while still exposing the ORIGINAL compressed content-length, so
  // forwarding it truncates the stream the browser actually receives. Letting
  // the adapter chunk the body is correct for both buffered JSON and SSE.
  'content-length',
  'content-encoding',
  // This process owns its own cookie scope; OpenCode must not set cookies on it.
  'set-cookie',
]);

export type OpencodeProxyResult =
  | { ok: true; upstream: Response; headers: Headers }
  | { ok: false; error: Response };

/**
 * Forward `event`'s request to `upstreamPath` on this process's OpenCode.
 *
 * `upstreamPath` is the path AFTER the route prefix, without a leading slash —
 * `/oc/session/x` and `/_opencode/session/x` both pass `session/x`. The query
 * string rides along from the event.
 *
 * Returns the raw upstream response plus the response headers already
 * sanitized, so a caller that only streams can hand both straight to
 * `new Response(...)` while a caller that rewrites the body can read
 * `upstream.text()` first.
 */
export async function proxyToAssistantOpencode(
  event: RequestEvent,
  upstreamPath: string,
  requestId: string,
): Promise<OpencodeProxyResult> {
  const target = getAssistantOpencodeTarget();
  const upstreamUrl = `${target.url.replace(/\/$/, '')}/${upstreamPath}${event.url.search}`;

  const method = event.request.method;
  // GET/HEAD carry no body — undici rejects one, and SvelteKit routes HEAD
  // through the GET handler, so both must be treated as bodyless.
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : await event.request.arrayBuffer();

  const headers = new Headers();
  for (const [key, value] of event.request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  for (const [key, value] of Object.entries(assistantAuthHeaders(target))) {
    headers.set(key, value);
  }

  // One abort source: the CLIENT's own disconnect (see the header comment).
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  event.request.signal?.addEventListener('abort', onClientAbort);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method, headers, body, signal: controller.signal });
  } catch {
    event.request.signal?.removeEventListener('abort', onClientAbort);
    return {
      ok: false,
      error: errorResponse(
        502,
        'assistant_unreachable',
        'The assistant is not responding — it may still be starting.',
        {},
        requestId,
      ),
    };
  }

  // The abort listener is deliberately NOT removed here. It must stay attached
  // for the life of the streamed body — that is the whole point of forwarding
  // it. Detaching once headers arrive would leave `/oc/event` unable to tear
  // down its upstream when the browser goes away, which is the leak this
  // guards against. The listener rides on the per-request signal and is
  // collected with it.
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  }
  responseHeaders.set('x-request-id', requestId);

  return { ok: true, upstream, headers: responseHeaders };
}
