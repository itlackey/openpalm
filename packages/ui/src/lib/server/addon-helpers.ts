/**
 * Shared addon enable/disable logic for admin route handlers.
 *
 * Both /admin/addons and /admin/addons/:name share the same POST flow:
 * validate → stop running services if disabling → mutate state → audit.
 * This module houses the shared mutation step so neither route duplicates it.
 */
import { createLogger, getAddonServiceNames, listEnabledAddonIds, setAddonEnabled, composeStop, buildComposeOptions, checkDocker } from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { errorResponse, jsonResponse } from './helpers.js';
import { withAdminUpdateLock } from './admin-update-lock.js';
import { resetState } from './state.js';

const logger = createLogger('addon-helpers');

type AddonToggleResult =
  | { ok: true; enabled: boolean; changed: boolean }
  | { ok: false; error: string };

/**
 * Stop running services if disabling, then call setAddonEnabled.
 */
async function performAddonToggleMutation(
  state: ControlPlaneState,
  name: string,
  requestedEnabled: boolean | undefined,
  requestId: string,
): Promise<AddonToggleResult> {
  const wasEnabled = listEnabledAddonIds(state.homeDir).includes(name);
  const nextEnabled = requestedEnabled !== undefined ? requestedEnabled : wasEnabled;

  if (!nextEnabled && wasEnabled) {
    const serviceNames = getAddonServiceNames(state.homeDir, name);
    if (serviceNames.length > 0) {
      const dockerCheck = await checkDocker();
      if (dockerCheck.ok) {
        try {
          await composeStop(serviceNames, buildComposeOptions(state));
          logger.info('stopped addon services before disable', { name, services: serviceNames, requestId });
        } catch (err) {
          logger.warn('failed to stop addon services before disable', { name, services: serviceNames, error: String(err), requestId });
        }
      }
    }
  }

  const mutation = setAddonEnabled(state.homeDir, name, nextEnabled, state);
  if (!mutation.ok) return mutation;

  // The shared state singleton seeds its expected-service set (CORE_SERVICES,
  // gated on whether a portal addon is enabled) ONCE at creation. setAddonEnabled
  // only rewrites OP_ENABLED_ADDONS on disk — it does NOT touch state.services —
  // so toggling a portal leaves the in-memory expected set stale until the host
  // process restarts. Most visibly: disabling the last portal left guardian in
  // state.services as a phantom "stopped" service that no longer belongs to the
  // stack. Bust the singleton so the next getState() re-derives the gated set
  // from the updated OP_ENABLED_ADDONS.
  if (mutation.changed) resetState();

  const resultEnabled = listEnabledAddonIds(state.homeDir).includes(name);
  return { ok: true, enabled: resultEnabled, changed: mutation.changed };
}

export function performAddonToggle(
  state: ControlPlaneState,
  name: string,
  requestedEnabled: boolean | undefined,
  requestId: string,
): Promise<Response> {
  return withAdminUpdateLock(state, requestId, async () => {
    const toggle = await performAddonToggleMutation(state, name, requestedEnabled, requestId);
    if (!toggle.ok) {
      return errorResponse(500, 'internal_error', toggle.error, {}, requestId);
    }
    return jsonResponse(
      200,
      { ok: true, addon: name, enabled: toggle.enabled, changed: toggle.changed },
      requestId,
    );
  });
}
