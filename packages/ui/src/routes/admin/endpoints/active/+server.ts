/**
 * POST /admin/endpoints/active — set the active assistant endpoint.
 *
 * Body: { id: string }  — pass "default" to revert to the env-derived entry.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  jsonResponse,
  withAdminBody,
} from '$lib/server/helpers.js';
import { setActiveId } from '$lib/server/endpoints.js';
import { appendAudit } from '@openpalm/lib';

export const POST: RequestHandler = async (event) =>
  withAdminBody(event, async ({ requestId, body }) => {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) {
      return errorResponse(400, 'invalid_request', 'id is required', {}, requestId);
    }

    try {
      const active = setActiveId(id);
      const state = getState();
      appendAudit(
        state,
        getActor(event),
        'endpoints.set-active',
        { id: active.id, label: active.label },
        true,
        requestId,
        getCallerType(event),
      );
      return jsonResponse(
        200,
        {
          activeId: active.id,
          endpoint: {
            id: active.id,
            label: active.label,
            url: active.url,
            isDefault: active.isDefault,
            hasPassword: Boolean(active.password),
          },
        },
        requestId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to set active endpoint';
      return errorResponse(404, 'not_found', msg, {}, requestId);
    }
  });
