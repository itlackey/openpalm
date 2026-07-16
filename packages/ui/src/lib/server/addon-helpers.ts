/**
 * Shared addon enable/disable logic for admin route handlers.
 *
 * Both /admin/addons and /admin/addons/:name share the same POST flow:
 * validate → stop running services if disabling → mutate state → audit.
 * This module houses the shared mutation step so neither route duplicates it.
 */
import { createLogger, getAddonProfiles, getAddonServiceNames, listEnabledAddonIds, setAddonEnabled, setAddonProfileSelection, composeStop, buildComposeOptions, checkDocker } from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { errorResponse, jsonResponse } from './helpers.js';
import { withAdminUpdateLock } from './admin-update-lock.js';
import { resetState } from './state.js';
import { VOICE_ADDON, engageVoiceAddon } from './voice/bring-up.js';

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

/**
 * Voice-addon enable / hardware-profile change: unlike a plain toggle, an
 * enable must actually bring the chosen compose profile up (port pre-flight,
 * first-pull background job, CDI/rootless overlay selection) — the
 * engageVoiceAddon engine. Returns 200 (healthy/warming), 202 (image pulling
 * in the background — the UI polls GET /api/host/addons/voice for the
 * activeJob), 400 (unknown profile), or 502 (bring-up failed).
 */
export function performVoiceEngage(
  state: ControlPlaneState,
  requestedProfile: string,
  requestId: string,
): Promise<Response> {
  return withAdminUpdateLock(state, requestId, async (_lock, deferReleaseUntil) => {
    const result = await engageVoiceAddon({ state, wantsVoiceAddon: true, requestedProfile });
    switch (result.status) {
      case 'invalid_profile':
        return errorResponse(400, 'invalid_profile', result.message, {}, requestId);
      case 'error':
        if (!result.wasAlreadyEnabled) resetState();
        return jsonResponse(
          502,
          {
            ok: false,
            addon: VOICE_ADDON,
            // The 'error' state covers both "enable succeeded, bring-up
            // failed" (addon IS enabled) and "the enable write itself threw"
            // (it is NOT) — report what actually happened.
            enabled: result.wasAlreadyEnabled || result.steps.some((s) => s.step === 'enable' && s.ok),
            voiceAddon: { steps: result.steps, error: result.error },
          },
          requestId,
        );
      case 'background':
        if (!result.wasAlreadyEnabled) resetState();
        deferReleaseUntil(result.completion);
        return jsonResponse(
          202,
          {
            ok: true,
            addon: VOICE_ADDON,
            enabled: true,
            voiceAddon: { status: 'pulling', steps: result.steps, message: result.message },
          },
          requestId,
        );
      case 'final':
        if (!result.wasAlreadyEnabled) resetState();
        return jsonResponse(
          result.healthy || result.warming ? 200 : 502,
          {
            ok: result.healthy || result.warming,
            addon: VOICE_ADDON,
            enabled: true,
            voiceAddon: {
              steps: result.steps,
              ...(result.warming ? { warming: true } : {}),
              ...(result.healthy || result.warming
                ? {}
                : { error: 'Voice addon is starting but did not become healthy in time.' }),
            },
          },
          requestId,
        );
      case 'disengaged':
        // Unreachable: wantsVoiceAddon is always true here.
        return jsonResponse(200, { ok: true, addon: VOICE_ADDON, enabled: true }, requestId);
    }
  });
}

/**
 * Route a POST /api/host/addons(/:name) body to the right mutation:
 *   - voice + enable (or a profile change while enabled) → the bring-up engine
 *   - voice + profile change while DISABLED → persist the selection only
 *   - everything else → the generic enable/disable toggle
 */
export function handleAddonToggleRequest(
  state: ControlPlaneState,
  name: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Response> {
  const requestedEnabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  const requestedProfile = typeof body.profile === 'string' ? body.profile.trim() : '';

  if (name === VOICE_ADDON && requestedEnabled !== false) {
    const isEnabled = listEnabledAddonIds(state.homeDir).includes(VOICE_ADDON);
    if (requestedEnabled === true || (requestedProfile && isEnabled)) {
      return performVoiceEngage(state, requestedProfile, requestId);
    }
    if (requestedProfile && !isEnabled) {
      // Disabled addon: remember the choice for the next enable, no compose.
      // Still taken under the admin lock — it writes state/stack.state.env,
      // which a concurrent install/update also mutates.
      const known = getAddonProfiles(state.homeDir, VOICE_ADDON).some((p) => p.id === requestedProfile);
      if (!known) {
        return Promise.resolve(
          errorResponse(400, 'invalid_profile', `Unknown voice profile "${requestedProfile}"`, {}, requestId),
        );
      }
      return withAdminUpdateLock(state, requestId, () => {
        setAddonProfileSelection(state.homeDir, VOICE_ADDON, requestedProfile);
        return jsonResponse(200, { ok: true, addon: VOICE_ADDON, enabled: false, changed: false }, requestId);
      });
    }
  }

  return performAddonToggle(state, name, requestedEnabled, requestId);
}
