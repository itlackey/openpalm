/**
 * Proxy route: forward /proxy/assistant/[...path] → assistant OpenCode server.
 *
 * Auth: requires x-admin-token (same as all admin API routes).
 * Forwards the full request body and method unchanged.
 * Applies HTTP Basic auth if OPENCODE_SERVER_PASSWORD is set.
 * Timeout: 150s — OpenCode responses can take 30–120s.
 */
import { requireAdmin, getRequestId } from '$lib/server/helpers.js';
import type { RequestHandler } from './$types';

const ASSISTANT_BASE_URL =
  process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL ?? 'http://localhost:4096';

const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';

function buildForwardHeaders(incomingContentType: string | null): HeadersInit {
  const headers: HeadersInit = {};
  if (incomingContentType) {
    headers['content-type'] = incomingContentType;
  }
  if (OPENCODE_PASSWORD) {
    headers['authorization'] = `Basic ${btoa(`:${OPENCODE_PASSWORD}`)}`;
  }
  return headers;
}

const handler: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const { path } = event.params;
  const targetUrl = `${ASSISTANT_BASE_URL}/${path}${event.url.search}`;

  const method = event.request.method;
  const contentType = event.request.headers.get('content-type');
  const body = method !== 'GET' && method !== 'HEAD' ? await event.request.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: buildForwardHeaders(contentType),
      body,
      signal: AbortSignal.timeout(150_000),
    });

    const responseBody = await upstream.arrayBuffer();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch (e) {
    console.warn('[proxy/assistant] Upstream request failed:', e);
    return new Response(
      JSON.stringify({ error: 'proxy_error', message: 'Assistant OpenCode is not reachable' }),
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
