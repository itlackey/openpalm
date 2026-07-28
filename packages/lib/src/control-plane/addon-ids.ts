/**
 * Canonical list of built-in addon IDs.
 *
 * Single source of truth — imported by both addons.ts and migrations.ts.
 * Update THIS file (and only this file) when adding or removing a built-in addon.
 *
 * Intentionally a pure-constants file with no imports so it can be safely
 * imported from anywhere without risk of circular dependencies.
 */
export const BUILTIN_ADDON_IDS: ReadonlyArray<string> = [
  'api', 'chat', 'discord', 'gateway', 'ollama', 'slack', 'voice',
] as const;

/**
 * Addons whose ingress is served by the guardian container.
 *
 * Single source of truth for guardian deploy gating. Must mirror the Compose
 * profile gate on the guardian service in
 * `packages/skeleton/system/stack/portals.compose.yml`
 * (`profiles: [addon.chat, addon.api, addon.discord, addon.slack, addon.gateway]`):
 * enabling any of these requires the guardian, so the deploy set, the
 * expected-service seed, and the activation loop all deploy/health-wait on it.
 *
 * NOTE: broader than PORTAL_SECRET_ADDON_IDS — `gateway` uses the guardian but
 * has no portal secret of its own (see below). Keep the two lists distinct.
 */
export const GUARDIAN_INGRESS_ADDON_IDS: ReadonlyArray<string> = [
  'api', 'chat', 'discord', 'gateway', 'slack',
] as const;

export function hasGuardianIngressAddon(enabledAddons: Iterable<string>): boolean {
  for (const addon of enabledAddons) {
    if (GUARDIAN_INGRESS_ADDON_IDS.includes(addon)) return true;
  }
  return false;
}

/**
 * First-party portals that own a dedicated `portal_<id>_secret`.
 *
 * Single source of truth for portal-secret provisioning (`ensurePortalSecret`).
 * Must mirror the `portal_*_secret` set the guardian mounts in
 * `portals.compose.yml` (chat, api, discord, slack). Excludes `gateway`, which
 * is guardian ingress but has no portal secret of its own.
 */
export const PORTAL_SECRET_ADDON_IDS: ReadonlyArray<string> = [
  'api', 'chat', 'discord', 'slack',
] as const;
