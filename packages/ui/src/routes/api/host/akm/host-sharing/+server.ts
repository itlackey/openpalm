/**
 * Host AKM sharing control surface.
 *
 *   GET    /api/host/akm/host-sharing  — { enabled, hostStashPath }
 *   PUT    /api/host/akm/host-sharing  — enable: set OP_HOST_AKM_STASH
 *   DELETE /api/host/akm/host-sharing  — disable: unset OP_HOST_AKM_STASH
 *
 * /host-stash is always mounted (core.compose.yml). /host-stash is always a
 * secondary akm source. Enable/disable only changes what the compose mount
 * points at (real stash vs empty dir) — the shared stash DIRECTORY is the
 * whole of host sharing; the host's own akm config and CLI are never read.
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
  requireCapability,
} from '$lib/server/helpers.js';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:akm-sharing', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, getHostAkmSharingStatus(getState()), requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:akm-sharing', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  return withAdminUpdateLock(state, requestId, () => {
    enableHostAkmSharing(state);
    return jsonResponse(200, getHostAkmSharingStatus(state), requestId);
  });
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:akm-sharing', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  return withAdminUpdateLock(state, requestId, () => {
    disableHostAkmSharing(state);
    return jsonResponse(200, getHostAkmSharingStatus(state), requestId);
  });
};
