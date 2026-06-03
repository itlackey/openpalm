/**
 * Host AKM sharing control surface.
 *
 *   GET    /admin/akm/host-sharing  — report { available, enabled, hostStashPath }
 *   PUT    /admin/akm/host-sharing  — enable: add the writable host-akm secondary
 *                                     source (optionally import host profiles)
 *   DELETE /admin/akm/host-sharing  — disable: remove the host-akm secondary source
 *
 * /host-stash is always mounted (core.compose.yml), so enabling/disabling is just a
 * config-source edit — no compose change. enable throws (409) if host AKM is not
 * available on the host. Disable never deletes any stash content. All orchestration
 * lives in @openpalm/lib so the wizard and this endpoint share one implementation.
 */
import type { RequestHandler } from './$types';
import {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  jsonBodyError,
  requireAdmin,
} from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, { sharing: getHostAkmSharingStatus(getState()) }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const opts = result.data;
  const writable = opts.writable === undefined ? true : opts.writable === true;
  const importProfiles = opts.importProfiles === true;

  const state = getState();
  try {
    const { profilesImported } = enableHostAkmSharing(state, { writable, importProfiles });
    return jsonResponse(200, { sharing: getHostAkmSharingStatus(state), profilesImported }, requestId);
  } catch (err) {
    // Host AKM not available (no ~/.config/akm/config.json) → 409.
    return errorResponse(409, 'conflict', (err as Error).message, {}, requestId);
  }
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  disableHostAkmSharing(state);
  return jsonResponse(200, { sharing: getHostAkmSharingStatus(state) }, requestId);
};
