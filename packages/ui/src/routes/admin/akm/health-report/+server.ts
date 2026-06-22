import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { buildAkmHealthReport } from '$lib/server/akm-health-report.js';

const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  try {
    const state = getState();
    const since = event.url.searchParams.get('since');
    const { html } = await buildAkmHealthReport(state, since);

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': REPORT_CSP,
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build AKM health report.';
    return new Response(message, {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
      },
    });
  }
};
