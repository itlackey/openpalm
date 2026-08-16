/**
 * POST /api/workspace/ticket — a one-minute, single-use credential that lets
 * this browser's OpenPalm session reach a workspace published on a different
 * hostname (see lib/server/workspace-ticket.ts for why that needs anything at
 * all, and what it deliberately does not try to fix).
 *
 * Session-gated and nothing more: any signed-in operator may open the
 * workspace — that is the premise of the whole feature — so there is no
 * capability narrower than "is this a valid session" to check.
 *
 * POST rather than GET because it mints a credential, which puts it behind the
 * SEC-2 Origin check in hooks.server.ts for free.
 */
import type { RequestHandler } from './$types';
import { getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';
import { mintWorkspaceTicket, WORKSPACE_TICKET_TTL_MS } from '$lib/server/workspace-ticket.js';

export const POST: RequestHandler = (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  return jsonResponse(
    200,
    { ticket: mintWorkspaceTicket(), expiresInMs: WORKSPACE_TICKET_TTL_MS },
    requestId,
  );
};
