/**
 * Proxy route: forward /proxy/assistant/[...path] → assistant OpenCode server.
 *
 * Auth: requires the operator's `op_session` cookie (cookie-only since
 * Phase 2 of the auth/proxy refactor — the `x-admin-token` header fallback
 * was removed).
 * Forwards the full request body and method unchanged.
 * The target URL and per-endpoint Basic-auth password are resolved per-request
 * from the active endpoint store, so switching endpoints in the UI takes
 * effect immediately without restarting the server.
 *
 * Streaming: the upstream response body is forwarded as-is (no buffering) so
 * SSE responses (text/event-stream) pass through chunk-by-chunk. We do not
 * impose a fixed timeout on the upstream fetch — OpenCode SSE streams can run
 * for minutes. Instead the per-request AbortController is wired to the client
 * disconnect signal (`event.request.signal`); when the browser aborts (tab
 * close, navigation away), we propagate the abort to upstream.
 */
import { basicAuthHeader } from '$lib/server/basic-auth.js';
import { requireAdmin, getRequestId } from '$lib/server/helpers.js';
import { getActiveEndpoint } from '$lib/server/endpoints.js';
import type { RequestHandler } from './$types';

function buildForwardHeaders(
  incomingContentType: string | null,
  username: string | undefined,
  password: string | undefined,
): HeadersInit {
  const headers: HeadersInit = {};
  if (incomingContentType) {
    headers['content-type'] = incomingContentType;
  }
  if (password) {
    // OpenCode rejects Basic auth with an empty username — the upstream
    // OpenCode's server default username is `"opencode"` and the shipped
    // assistant compose never overrides OPENCODE_SERVER_USERNAME, so an
    // endpoint without an explicit username must forward `opencode:<pw>` or a
    // correct password 401s (PR #564 r3566888629).
    const user = username || 'opencode';
    headers.authorization = basicAuthHeader(user, password);
  }
  return headers;
}

function buildResponseHeaders(
  upstream: Response,
  requestId: string,
  endpointId: string,
  endpointLabel: string,
): Headers {
  const headers = new Headers();
  // Forward useful upstream headers; preserve identity-style streaming hints.
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
  const cacheControl = upstream.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);
  const transferEncoding = upstream.headers.get('transfer-encoding');
  if (transferEncoding) headers.set('transfer-encoding', transferEncoding);
  // Always preserve our diagnostic headers.
  headers.set('x-request-id', requestId);
  headers.set('x-endpoint-id', endpointId);
  headers.set('x-endpoint-label', encodeURIComponent(endpointLabel));
  return headers;
}

const handler: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const endpoint = getActiveEndpoint();
  const { path } = event.params;
  const targetUrl = `${endpoint.url}/${path}${event.url.search}`;

  const method = event.request.method;
  const contentType = event.request.headers.get('content-type');
  const body = method !== 'GET' && method !== 'HEAD' ? await event.request.arrayBuffer() : undefined;

  // No fixed timeout — SSE streams may legitimately run for minutes. Propagate
  // the client's disconnect signal so an aborted browser request tears down
  // the upstream connection promptly.
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  event.request.signal.addEventListener('abort', onClientAbort, { once: true });

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: buildForwardHeaders(contentType, endpoint.username, endpoint.password),
      body,
      signal: controller.signal,
    });

    // Return upstream.body directly so adapter-node streams the chunks to the
    // client. await upstream.arrayBuffer() here would buffer entire SSE
    // responses in memory and break streaming completions.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream, requestId, endpoint.id, endpoint.label),
    });
  } catch (e) {
    event.request.signal.removeEventListener('abort', onClientAbort);
    console.warn('[proxy/assistant] Upstream request failed:', e);
    return new Response(
      JSON.stringify({
        error: 'endpoint_unreachable',
        message: `Assistant endpoint "${endpoint.label}" is not reachable`,
        endpointId: endpoint.id,
        endpointLabel: endpoint.label,
        url: endpoint.url,
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      }
    );
  }
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
