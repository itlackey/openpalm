/**
 * /admin/endpoints/[id] — update or delete a user-added endpoint.
 *
 * The "default" id is reserved and cannot be edited or deleted.
 * Passwords are write-only in the API surface — pass `password: null` to
 * clear, a string to set, or omit to leave unchanged.
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
  deleteEndpoint,
  updateEndpoint,
  validateEndpointUrl,
  type EndpointPatch,
} from '$lib/server/endpoints.js';

export const PATCH: RequestHandler = async (event) =>
  withAdminBody(event, async ({ requestId, body }) => {
    const id = event.params.id;
    const patch: EndpointPatch = {};
    if (typeof body.label === 'string') patch.label = body.label;
    if (typeof body.url === 'string') {
      // Validate up-front so the HTTPS-for-remote rule (Phase 6) surfaces a
      // specific error code, not a generic "URL must be a valid http(s) URL".
      const urlCheck = validateEndpointUrl(body.url);
      if (!urlCheck.ok) {
        if (urlCheck.reason === 'http_not_allowed') {
          return errorResponse(
            400,
            'http_not_allowed',
            'Plain HTTP is only allowed for loopback addresses. Use https:// for remote OpenPalm instances.',
            {},
            requestId,
          );
        }
        return errorResponse(400, 'invalid_endpoint', 'URL must be a valid http(s) URL', {}, requestId);
      }
      patch.url = urlCheck.url;
    }
    if (body.password === null) patch.password = null;
    else if (typeof body.password === 'string') patch.password = body.password;

    try {
      const entry = updateEndpoint(id, patch);
      return jsonResponse(
        200,
        {
          endpoint: {
            id: entry.id,
            label: entry.label,
            url: entry.url,
            isDefault: false,
            hasPassword: Boolean(entry.password),
          },
        },
        requestId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to update endpoint';
      const status = msg.startsWith('Endpoint not found') ? 404 : 400;
      return errorResponse(status, status === 404 ? 'not_found' : 'invalid_endpoint', msg, {}, requestId);
    }
  });

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const id = event.params.id;
  try {
    deleteEndpoint(id);
    return jsonResponse(200, { ok: true }, requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed to delete endpoint';
    const status = msg.startsWith('Endpoint not found') ? 404 : 400;
    return errorResponse(status, status === 404 ? 'not_found' : 'invalid_endpoint', msg, {}, requestId);
  }
};
