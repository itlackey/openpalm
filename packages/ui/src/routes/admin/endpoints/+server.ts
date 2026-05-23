/**
 * /admin/endpoints — list and create assistant endpoints.
 *
 * The "default" entry is synthesized from environment (OP_OPENCODE_URL etc.)
 * and is always first in the list. User-added endpoints are persisted to
 * state/admin/endpoints.json. Passwords are never returned — only
 * `hasPassword: boolean`.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  requireAdmin,
  withAdminBody,
} from '$lib/server/helpers.js';
import {
  addEndpoint,
  getActiveEndpoint,
  listEndpoints,
  type ActiveEndpoint,
} from '$lib/server/endpoints.js';
import { appendAudit } from '@openpalm/lib';

type PublicEndpoint = {
  id: string;
  label: string;
  url: string;
  isDefault: boolean;
  hasPassword: boolean;
};

function publish(e: ActiveEndpoint): PublicEndpoint {
  return {
    id: e.id,
    label: e.label,
    url: e.url,
    isDefault: e.isDefault,
    hasPassword: Boolean(e.password),
  };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const endpoints = listEndpoints().map(publish);
  const active = publish(getActiveEndpoint());

  return jsonResponse(200, { endpoints, activeId: active.id }, requestId);
};

export const POST: RequestHandler = async (event) =>
  withAdminBody(event, async ({ requestId, body }) => {
    const label = typeof body.label === 'string' ? body.label : '';
    const url = typeof body.url === 'string' ? body.url : '';
    const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;

    try {
      const entry = addEndpoint({ label, url, password });
      const state = getState();
      appendAudit(
        state,
        getActor(event),
        'endpoints.create',
        { id: entry.id, label: entry.label, url: entry.url, hasPassword: Boolean(entry.password) },
        true,
        requestId,
        getCallerType(event),
      );
      return jsonResponse(201, { endpoint: publish({ ...entry, isDefault: false }) }, requestId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to create endpoint';
      return errorResponse(400, 'invalid_endpoint', msg, {}, requestId);
    }
  });
