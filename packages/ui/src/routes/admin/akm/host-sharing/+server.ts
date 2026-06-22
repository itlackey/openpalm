/**
 * Host AKM sharing control surface.
 *
 *   GET    /admin/akm/host-sharing  — { enabled, hostStashPath }
 *   PUT    /admin/akm/host-sharing  — enable: set OP_HOST_AKM_STASH + import profiles
 *   DELETE /admin/akm/host-sharing  — disable: unset OP_HOST_AKM_STASH
 *
 * /host-stash is always mounted (core.compose.yml). /host-stash is always a
 * secondary akm source. Enable/disable only changes what the compose mount
 * points at (real stash vs empty dir). Profile import on enable is best-effort.
 */
import type { RequestHandler } from './$types';
import {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, getHostAkmSharingStatus(getState()), requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const { profilesImported } = enableHostAkmSharing(state);
  return jsonResponse(200, { ...getHostAkmSharingStatus(state), profilesImported }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  disableHostAkmSharing(state);
  return jsonResponse(200, getHostAkmSharingStatus(state), requestId);
};
