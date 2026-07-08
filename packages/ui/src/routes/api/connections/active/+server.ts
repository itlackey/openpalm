/**
 * POST /api/connections/active — set the active assistant connection (plan
 * ui-runtime-modes-plan.md Phase 2, issue #486).
 *
 * Guarded by `connections:manage` (server-side; see /api/connections).
 * Body: { id: string } — pass "default" to revert to the env-derived entry.
 */
import type { RequestHandler } from './$types';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';
import { publishConnection } from '$lib/server/connections-api.js';
import { setActiveConnectionId } from '$lib/server/endpoints.js';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'connections:manage', requestId);
  if (capabilityError) return capabilityError;

  return withAdminBody(event, async ({ requestId, body }) => {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) {
      return errorResponse(400, 'invalid_request', 'id is required', {}, requestId);
    }

    try {
      const active = setActiveConnectionId(id);
      return jsonResponse(
        200,
        { activeId: active.id, connection: publishConnection(active) },
        requestId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to set active connection';
      return errorResponse(404, 'not_found', msg, {}, requestId);
    }
  });
};
