/**
 * /admin/endpoints — list and create assistant endpoints.
 *
 * The "default" entry is synthesized from environment (OP_OPENCODE_URL etc.)
 * and is always first in the list. User-added endpoints are persisted to
 * config/endpoints.json. Passwords are never returned — only
 * `hasPassword: boolean`.
 */
import type { RequestHandler } from './$types';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  withAdminBody,
} from '$lib/server/helpers.js';
import {
  addEndpoint,
  getActiveEndpoint,
  listEndpoints,
  validateEndpointUrl,
  type ActiveEndpoint,
} from '$lib/server/endpoints.js';

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

    const urlCheck = validateEndpointUrl(url);
    if (!urlCheck.ok) {
      return errorResponse(400, 'invalid_endpoint', 'URL must be a valid http(s) URL', {}, requestId);
    }

    try {
      const entry = addEndpoint({ label, url: urlCheck.url, password });
      return jsonResponse(
        201,
        { endpoint: publish({ ...entry, kind: entry.kind ?? 'remote-opencode', isDefault: false }) },
        requestId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to create endpoint';
      return errorResponse(400, 'invalid_endpoint', msg, {}, requestId);
    }
  });
