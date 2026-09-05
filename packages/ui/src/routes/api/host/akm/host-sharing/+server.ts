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
 *
 * Both directions APPLY. `OP_HOST_AKM_STASH` is the SOURCE of a bind mount
 * (core.compose.yml: `${OP_HOST_AKM_STASH:-…}:/host-stash`), and a mount can
 * only change when the container is created — `compose restart` reuses the
 * existing mounts. The UI used to tell the operator to "restart the stack",
 * which cannot work: they would flip the toggle, see Enabled, restart, and
 * still get the empty-dir fallback with no error anywhere. Recreating the
 * assistant here is the same "a save is an APPLY" rule access-apply.ts
 * enforces for every other setting whose effect is a compose fact.
 */
import type { RequestHandler } from './$types';
import {
  activateStack,
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
  requireInstalledHome
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
  const notInstalled = requireInstalledHome(state.homeDir, requestId);
  if (notInstalled) return notInstalled;
  return withAdminUpdateLock(state, requestId, async (lock) => {
    enableHostAkmSharing(state);
    // The mount source changed; only a recreate picks that up.
    await activateStack(state, { kind: 'services', services: ['assistant'] }, {}, { lock });
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
  return withAdminUpdateLock(state, requestId, async (lock) => {
    disableHostAkmSharing(state);
    // The mount source changed; only a recreate picks that up.
    await activateStack(state, { kind: 'services', services: ['assistant'] }, {}, { lock });
    return jsonResponse(200, getHostAkmSharingStatus(state), requestId);
  });
};
