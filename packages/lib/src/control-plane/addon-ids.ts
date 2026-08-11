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
  'api', 'discord', 'gateway', 'ollama', 'paperclip', 'remote', 'slack', 'voice',
] as const;

/**
 * Addons whose ingress is served by the guardian container.
 *
 * One reason (of several) the guardian deploys. Must mirror the `addon.*`
 * entries in the Compose profile gate on the guardian service in
 * `packages/skeleton/system/stack/portals.compose.yml`
 * (`profiles: [addon.api, addon.discord, addon.slack, addon.gateway, guardian]`):
 * enabling any of these requires the guardian. The full "does the guardian
 * deploy?" answer — these addons OR the guardian access toggles OR the
 * remote-tunnels-to-guardian reason — is `guardianRequired` in
 * `guardian-required.ts`, which the deploy set, the expected-service seed,
 * and the activation loop all consult.
 *
 * NOTE: broader than PORTAL_SECRET_ADDON_IDS — `gateway` uses the guardian but
 * has no portal secret of its own (see below). Keep the two lists distinct.
 */
export const GUARDIAN_INGRESS_ADDON_IDS: ReadonlyArray<string> = [
  'api', 'discord', 'gateway', 'slack',
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
 * `portals.compose.yml` (api, discord, slack). Excludes `gateway`, which is
 * guardian ingress but has no portal secret of its own. `api` stays here even
 * though its addon is an exposure alias: `portal_api_secret` is the
 * OpenAI-compatible edge's own principal credential
 * (`PRINCIPAL_SECRET_FILE` in portals.compose.yml), mounted on every guardian
 * deploy, so it must be seeded regardless of which addon is enabled.
 */
export const PORTAL_SECRET_ADDON_IDS: ReadonlyArray<string> = [
  'api', 'discord', 'slack',
] as const;

/**
 * Addons that work but are NOT fully supported yet.
 *
 * "Experimental" here means one specific promise is withheld: OpenPalm does
 * not guarantee this addon comes up cleanly on every install, because what it
 * depends on is outside this codebase. It is not a judgement about how useful
 * the addon is, and it does not disable, hide, or gate anything — enabling one
 * is a normal enable. The only effect is that the operator is told before they
 * turn it on.
 *
 * It is NOT a lower testing bar. The checks OpenPalm does run against these
 * addons still gate a release — paperclip's cold start is a release-checklist
 * item precisely because it is experimental and upstream can break it. The
 * label describes what OpenPalm cannot promise about the operator's
 * environment, not what OpenPalm declines to verify in its own.
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
