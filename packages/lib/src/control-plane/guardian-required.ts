/**
 * The ONE answer to "does this install deploy the guardian?".
 *
 * The guardian is not a core service: Compose deploys it only when a profile
 * on it is active (`portals.compose.yml`). Historically the only profiles
 * were `addon.*` ones, so anything that needed the guardian had to reach
 * backwards and enable an addon — which is how the access toggles grew an
 * auto-enable hack that flipped integrations the operator never asked for
 * ("the published port has nothing behind it otherwise"). Exposure toggles
 * and integrations are different axes; conflating them is what this module
 * removes.
 *
 * The reasons the guardian deploys, in one place:
 *
 *  1. a guardian-ingress addon is enabled (`GUARDIAN_INGRESS_ADDON_IDS`) —
 *     Compose activates that addon's own profile;
 *  2. the `guardianNetwork` access toggle — the operator published the
 *     guardian's front door;
 *  3. the `guardianOpenaiApi` access toggle — the operator published the
 *     OpenAI-compatible edge the guardian serves;
 *  4. the `remote` addon tunnels to the guardian
 *     (`computeGuardianIngressRequired`) — traffic arrives over `portal_net`
 *     with every LAN bind still loopback.
 *
 * Reasons 2–4 activate the bare `guardian` profile (`GUARDIAN_PROFILE`) via
 * `resolveActiveProfiles`, so the guardian deploys with no addon involved.
 * This answers DEPLOYMENT only; whether the direct listener answers is still
 * `GUARDIAN_DIRECT_INGRESS` (`resolveAccessEnv`), and where each listener
 * binds is still the flat per-service bind keys.
 */
import { hasGuardianIngressAddon } from "./addon-ids.js";
import { readAccessToggles } from "./access-toggles.js";
import { computeGuardianIngressRequired } from "./remote-providers.js";
import { parseEnabledAddons } from "./env.js";
import { readStackEnv } from "./secrets.js";

/**
 * The profile that deploys the guardian for a non-addon reason. Named without
 * the `addon.` prefix deliberately: it is not an addon, and the prefix is what
 * `getAddonServiceNames` keys on to attribute services to addons.
 */
export const GUARDIAN_PROFILE = "guardian";

/** Pure form, for callers that already hold the env snapshot. */
export function guardianRequiredForEnv(env: Record<string, string | undefined>): boolean {
  if (hasGuardianIngressAddon(parseEnabledAddons(env.OP_ENABLED_ADDONS))) return true;
  const toggles = readAccessToggles(env);
  if (toggles.guardianNetwork || toggles.guardianOpenaiApi) return true;
  // The registry throws on an explicitly-invalid OP_REMOTE_TARGET (a hand
  // edit; every writer validates). This function feeds deploy sets and
  // profile resolution on paths that must not start failing because of a
  // typo'd unrelated key, so treat the unparseable case as "required": the
  // remote addon IS enabled and was tunnelling somewhere, and keeping the
  // guardian deployed publishes nothing new (its binds still follow the
  // toggles, loopback by default). The apply paths that can FIX the value
  // still surface the error — access-apply refuses the save with it.
  try {
    return computeGuardianIngressRequired(env);
  } catch {
    return true;
  }
}

/** True when this home's configuration requires the guardian to be deployed. */
export function guardianRequired(homeDir: string): boolean {
  return guardianRequiredForEnv(readStackEnv(homeDir));
}
