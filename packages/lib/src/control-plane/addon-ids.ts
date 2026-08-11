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
  'api', 'chat', 'discord', 'gateway', 'ollama', 'paperclip', 'remote', 'slack', 'voice',
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

/**
 * Addons that work but are NOT fully supported yet.
 *
 * "Experimental" here means one specific promise is withheld: OpenPalm does
 * not guarantee this addon comes up cleanly on every install, and a failure in
 * it is not treated as a release blocker. It is not a judgement about how
 * useful the addon is, and it does not disable, hide, or gate anything —
 * enabling one is a normal enable. The only effect is that the operator is
 * told before they turn it on.
 *
 * The bar to be listed here is evidence, not caution:
 *
 *  - `paperclip` — depends on a third-party image OpenPalm does not build and
 *    cannot patch. Its embedded Postgres could not initialise at all on a
 *    fresh data directory until 0.13.0-beta.25 (upstream hardcodes a locale
 *    its own image does not ship), and the workaround in
 *    `services.compose.yml` is ours, not upstream's. The next digest bump can
 *    reintroduce that class of failure without warning.
 *  - `remote` — depends on a third-party tunnel image plus an external service
 *    (a tailnet, its auth key, and Funnel permissions) that OpenPalm can
 *    neither provision nor verify. Its failure modes live outside this
 *    codebase, and the acceptance lane for it cannot run unattended.
 *
 * Single source of truth: the addons API surfaces this flag and the Add-ons
 * tab renders it. Removing an id here is how an addon graduates.
 */
export const EXPERIMENTAL_ADDON_IDS: ReadonlyArray<string> = [
  'paperclip', 'remote',
] as const;

/** True when `name` is an addon OpenPalm ships but does not fully support. */
export function isExperimentalAddon(name: string): boolean {
  return EXPERIMENTAL_ADDON_IDS.includes(name);
}
