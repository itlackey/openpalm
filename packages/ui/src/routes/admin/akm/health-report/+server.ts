import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { buildAkmHealthReport } from '$lib/server/akm-health-report.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  const since = event.url.searchParams.get('since');
  const { html } = await buildAkmHealthReport(state, since);

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  });
};
