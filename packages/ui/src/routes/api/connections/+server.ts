/**
 * /api/connections — list and create assistant connections (plan
 * ui-runtime-modes-plan.md Phase 2, issue #486).
 *
 * Guarded SERVER-SIDE by the `connections:manage` capability (plan §6.4,
 * §8.5): host-ui / electron-host / pwa-static expose it, assistant-container
 * does not — there the guard returns 403 even for a valid admin session,
 * because the check is capability-based (hostMode → serverCapabilities), not
 * session-based. Requests additionally require the admin session (plan §6.8:
 * the host app gates connection management behind the host admin session).
 *
 * Delegates to the same server module as the legacy /admin/endpoints routes
 * (lib/server/endpoints.ts); the on-disk endpoints.json is shared and NOT
 * renamed. Passwords are never returned — only `hasPassword: boolean`.
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
  publishConnection,
  publishConnectionEntry,
  requireConnectionsManage,
} from '$lib/server/connections-api.js';
import {
  addConnection,
  getActiveConnection,
  listConnections,
  validateConnectionUrl,
  USER_ADDABLE_CONNECTION_KINDS,
} from '$lib/server/endpoints.js';
import type { ConnectionKind } from '$lib/types.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const guardError = requireConnectionsManage(event, requestId);
  if (guardError) return guardError;

  const connections = listConnections().map(publishConnection);
  const active = publishConnection(getActiveConnection());

  return jsonResponse(200, { connections, activeId: active.id }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'connections:manage', requestId);
  if (capabilityError) return capabilityError;

  return withAdminBody(event, async ({ requestId, body }) => {
    const label = typeof body.label === 'string' ? body.label : '';
    const url = typeof body.url === 'string' ? body.url : '';
    const password =
      typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;

    // #486 D2: absent -> omitted; a string in USER_ADDABLE_CONNECTION_KINDS
    // -> passed to addConnection; anything else (incl. the reserved
    // 'local-opencode') -> 400 invalid_connection.
    let kind: ConnectionKind | undefined;
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
      kind = body.kind as ConnectionKind;
    }

    const urlCheck = validateConnectionUrl(url);
    if (!urlCheck.ok) {
      return errorResponse(400, 'invalid_connection', 'URL must be a valid http(s) URL', {}, requestId);
    }

    try {
      const entry = addConnection({ label, url: urlCheck.url, password, kind });
      return jsonResponse(201, { connection: publishConnectionEntry(entry) }, requestId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to create connection';
      return errorResponse(400, 'invalid_connection', msg, {}, requestId);
    }
  });
};
