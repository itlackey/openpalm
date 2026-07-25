/**
 * /oc/* — transparent same-origin pass-through to this process's OpenCode.
 *
 * The last leg of the same-origin migration. `/voice` already works this way
 * (see `routes/voice/[...path]/+server.ts`, whose header comment states the
 * thesis); OpenCode was the only service still talking to the browser
 * directly, and every artifact that looked like independent complexity was a
 * consequence of that one gap:
 *
 *   - a CORS allowlist the container cannot compute, because only the host can
 *     enumerate its own LAN addresses;
 *   - a client-side rewrite of the seeded `127.0.0.1` connection URL to
 *     whatever host the browser actually visited;
 *   - a mixed-content policy, because the UI and OpenCode were two origins
 *     with two independent TLS decisions;
 *   - a second password, because a LAN-published OpenCode needs its own auth.
 *
 * None of those exist for a same-origin path. The browser calls `/oc/...` on
 * the origin it already loaded, carrying the session cookie it already has,
 * and this process makes the local hop.
 *
 * Upstream resolution is `getHostOpencodeTarget()` — the same resolver the
 * host's own server routes use — so ONE code path serves both topologies:
 *   - container co-process: `OP_OPENCODE_URL=http://localhost:4096`, set by
 *     the assistant entrypoint;
 *   - host process (`openpalm app` / `admin` / Electron): the env-derived
 *     `127.0.0.1:${OP_ASSISTANT_PORT}`, or the Electron-spawned child.
 *
 * Basic auth for the upstream is attached HERE, server-side, from the same
 * resolver. That is what closes the third LAN failure: the seeded connection
 * used to carry `auth: { mode: "none" }` regardless of `OPENCODE_AUTH`, so the
 * browser 401'd against an auth-enabled OpenCode and the operator had to paste
 * the password into the connection editor by hand. The browser now never sees
 * an OpenCode credential at all.
 *
 * Remote/third-party assistants are unaffected: they keep the browser-direct
 * transport and their own credentials. The split is now meaningful rather than
 * incidental — *this* assistant is same-origin, *other* assistants are direct.
 */
import type { RequestHandler } from './$types';
import { errorResponse, getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { getHostOpencodeTarget } from '$lib/server/opencode-target.js';

/**
 * Bounds the CONNECTION + response headers, never the streamed body. OpenCode's
 * `/event` stream is open for the life of a session and a long completion can
 * stream past any fixed budget — aborting mid-body would hand the client a
 * truncated response it already saw a 200 for.
 */
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000;

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

const handle: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  // The session IS the credential for the local assistant. Same check as every
  // other authenticated route, so a served non-admin process works too —
  // reaching your own assistant is not a privileged host operation.
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const target = getHostOpencodeTarget();
  const path = event.params.path ?? '';
  const upstreamUrl = `${target.url.replace(/\/$/, '')}/${path}${event.url.search}`;

  const method = event.request.method;
  // GET/HEAD carry no body — undici rejects one, and SvelteKit routes HEAD
  // through the GET handler, so both must be treated as bodyless.
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : await event.request.arrayBuffer();

  const headers = new Headers();
  for (const [key, value] of event.request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  if (target.password) {
    const credentials = Buffer.from(`${target.username ?? 'opencode'}:${target.password}`).toString(
      'base64',
    );
    headers.set('authorization', `Basic ${credentials}`);
  }

  // Two abort sources, deliberately combined:
  //   1. a header timeout, cleared the moment headers arrive;
  //   2. the CLIENT's own disconnect. Forwarding it matters for `/oc/event`:
  //      without it, every SSE reconnect would leak an upstream subscription
  //      that OpenCode keeps alive for a browser that is already gone.
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), UPSTREAM_HEADER_TIMEOUT_MS);
  const onClientAbort = () => controller.abort();
  event.request.signal?.addEventListener('abort', onClientAbort);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method, headers, body, signal: controller.signal });
  } catch {
    clearTimeout(headerTimeout);
    event.request.signal?.removeEventListener('abort', onClientAbort);
    return errorResponse(
      502,
      'assistant_unreachable',
      'The assistant is not responding — it may still be starting.',
      {},
      requestId,
    );
  }
  clearTimeout(headerTimeout);

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  }
  responseHeaders.set('x-request-id', requestId);

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
