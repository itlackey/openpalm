/**
 * Shared addon enable/disable logic for admin route handlers.
 *
 * Both /admin/addons and /admin/addons/:name share the same POST flow:
 * validate → stop running services if disabling → mutate state → audit.
 * This module houses the shared mutation step so neither route duplicates it.
 */
import { createLogger, getAddonServiceNames, listEnabledAddonIds, setAddonEnabled, composeStop, buildComposeOptions, checkDocker } from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';

const logger = createLogger('addon-helpers');

export type AddonToggleResult =
  | { ok: true; enabled: boolean; changed: boolean }
  | { ok: false; error: string };

/**
 * Stop running services if disabling, then call setAddonEnabled.
 * Returns the mutation result with the final enabled state.
 */
export async function performAddonToggle(
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

  const mutation = setAddonEnabled(state.homeDir, state.stackDir, name, nextEnabled, state);
  if (!mutation.ok) return mutation;

  const resultEnabled = listEnabledAddonIds(state.homeDir).includes(name);
  return { ok: true, enabled: resultEnabled, changed: mutation.changed };
}
