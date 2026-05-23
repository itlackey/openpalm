/**
 * Proxy route: forward /proxy/assistant/[...path] → assistant OpenCode server.
 *
 * Auth: requires the operator's admin session (cookie or x-admin-token).
 * Forwards the full request body and method unchanged.
 * The target URL and per-endpoint Basic-auth password are resolved per-request
 * from the active endpoint store, so switching endpoints in the UI takes
 * effect immediately without restarting the server.
 * Timeout: 150s — OpenCode responses can take 30–120s.
 */
import { requireAdmin, getRequestId } from '$lib/server/helpers.js';
import { getActiveEndpoint } from '$lib/server/endpoints.js';
import type { RequestHandler } from './$types';

function buildForwardHeaders(incomingContentType: string | null, password: string | undefined): HeadersInit {
  const headers: HeadersInit = {};
  if (incomingContentType) {
    headers['content-type'] = incomingContentType;
  }
  if (password) {
    headers['authorization'] = `Basic ${btoa(`:${password}`)}`;
  }
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

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: buildForwardHeaders(contentType, endpoint.password),
      body,
      signal: AbortSignal.timeout(150_000),
    });

    const responseBody = await upstream.arrayBuffer();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
        'x-endpoint-id': endpoint.id,
        'x-endpoint-label': encodeURIComponent(endpoint.label),
      },
    });
  } catch (e) {
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
