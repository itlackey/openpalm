/**
 * /api/connections/[id] — update or delete a user-added connection (plan
 * ui-runtime-modes-plan.md Phase 2, issue #486).
 *
 * Guarded by `connections:manage` (server-side; see /api/connections). The
 * "default" id is reserved and cannot be edited or deleted. Passwords are
 * write-only in the API surface — pass `password: null` to clear, a string
 * to set, or omit to leave unchanged.
 */
import type { RequestHandler } from './$types';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';
import {
  publishConnectionEntry,
  requireConnectionsManage,
} from '$lib/server/connections-api.js';
import {
  deleteConnection,
  updateConnection,
  validateConnectionUrl,
  USER_ADDABLE_CONNECTION_KINDS,
  type ConnectionPatch,
} from '$lib/server/endpoints.js';
import type { ConnectionKind } from '$lib/types.js';

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'connections:manage', requestId);
  if (capabilityError) return capabilityError;

  return withAdminBody(event, async ({ requestId, body }) => {
    const id = event.params.id;
    const patch: ConnectionPatch = {};
    if (typeof body.label === 'string') patch.label = body.label;
    if (typeof body.url === 'string') {
      const urlCheck = validateConnectionUrl(body.url);
      if (!urlCheck.ok) {
        return errorResponse(400, 'invalid_connection', 'URL must be a valid http(s) URL', {}, requestId);
      }
      patch.url = urlCheck.url;
    }
    if (body.password === null) patch.password = null;
    else if (typeof body.password === 'string') patch.password = body.password;
    // #486 D2: same optional parse as POST /api/connections.
    if (body.kind !== undefined) {
      if (
        typeof body.kind !== 'string' ||
        !(USER_ADDABLE_CONNECTION_KINDS as readonly string[]).includes(body.kind)
      ) {
        return errorResponse(
          400,
          'invalid_connection',
          'kind must be remote-opencode or openpalm-client-api',
          {},
          requestId
        );
      }
      patch.kind = body.kind as ConnectionKind;
    }

    try {
      const entry = updateConnection(id, patch);
      return jsonResponse(200, { connection: publishConnectionEntry(entry) }, requestId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to update connection';
      const status = msg.startsWith('Endpoint not found') ? 404 : 400;
      return errorResponse(status, status === 404 ? 'not_found' : 'invalid_connection', msg, {}, requestId);
    }
  });
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const guardError = requireConnectionsManage(event, requestId);
  if (guardError) return guardError;

  const id = event.params.id;
  try {
    deleteConnection(id);
    return jsonResponse(200, { ok: true }, requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed to delete connection';
    const status = msg.startsWith('Endpoint not found') ? 404 : 400;
    return errorResponse(status, status === 404 ? 'not_found' : 'invalid_connection', msg, {}, requestId);
  }
};
