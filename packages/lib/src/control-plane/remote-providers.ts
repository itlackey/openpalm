/**
 * Remote access providers — the registry that makes the `remote` addon's
 * engine swappable (roadmap: `.github/roadmap/0.14.0/remote-access-providers.md`).
 *
 * The `remote` addon is one capability with mutually-exclusive provider
 * variants: each provider is a compose profile (`addon.remote.<id>`), and
 * `OP_REMOTE_PROFILE` selects which one deploys. This module owns the
 * PROVIDER MODEL: the metadata table the control plane and UI program
 * against (services, env keys, secrets, the guardian-ingress predicate, the
 * exposure summary) and the normalized `RemoteAccessStatus` vocabulary every
 * provider's status maps into so one UI card can render any of them.
 *
 * What deliberately does NOT live here: each provider's artifact machinery
 * (Tailscale's serve.json writes in remote-apply.ts; later providers'
 * generated files) and anything that shells out. The node-side dispatchers —
 * `remote-provider-apply.ts` (applyConfig) and `remote-provider-status.ts`
 * (fetchStatus) — key off this table without this module importing them,
 * which is what keeps the import graph acyclic: addons.ts and remote-apply.ts
 * can both consume this module because it depends only on leaves
 * (addon-ids, env, profile-ids, remote-access, access-toggles).
 */
import { parseEnabledAddons } from "./env.js";
import { DEFAULT_WORKSPACE_PORT, resolveEnvPort } from "./network-contract.js";
import { canonicalAddonProfileSelection } from "./profile-ids.js";
import { readRemoteAccessConfig, describeRemoteExposure } from "./remote-access.js";
import { remoteRequiresGuardianIngress } from "./access-toggles.js";

// ── The normalized status vocabulary ─────────────────────────────────────

export const REMOTE_ACCESS_STATUS_STATES = [
  "off", // addon disabled
  "awaiting-config", // enabled, required inputs missing
  "awaiting-authentication", // needs a human to click/sign in
  "pending-external", // waiting on the world: DNS, certificates
  "starting",
  "up",
  "degraded", // running, but a named part is not
  "error",
] as const;
export type RemoteAccessStatusState = (typeof REMOTE_ACCESS_STATUS_STATES)[number];

/**
 * One type every provider's `fetchStatus` maps into, designed so the UI
 * renders providers it has never heard of: a state, one sentence, at most
 * one action button, copyable facts, and named progress stages. Two rules
 * carry over from the shipped invariants: states clear only by OBSERVATION
 * (poll the fact, never trust a clicked "done"), and a URL is advertised
 * LAST — `copyables` may carry a URL only in `up`.
 */
export type RemoteAccessStatus = {
  state: RemoteAccessStatusState;
  /** One sentence in the operator's language. Required. */
  message: string;
  /** At most one primary action — a button, not a paragraph. */
  action?: { label: string; url: string };
  /** Copyable facts: URLs, DNS records, commands. `qr` renders a QR code. */
  copyables?: { label: string; value: string; qr?: boolean }[];
  /** Named stages for slow paths — never a bare spinner. */
  progress?: { stage: string; done: boolean }[];
};

// ── The provider model ───────────────────────────────────────────────────

/**
 * The browser-shareable half of a provider definition: identity, compose
 * wiring, and the pure predicates. The node halves (`applyConfig`,
 * `fetchStatus`) are dispatched by provider id in remote-provider-apply.ts /
 * remote-provider-status.ts — see the module docblock for why the split
 * exists (import-graph acyclicity), and remote-access-providers.md §3 for
 * the combined contract this implements.
 */
export type RemoteProviderInfo = {
  /** Registry key and profile suffix: "tailscale", later "pangolin-proxy"… */
  id: string;
  /** Operator-facing name for the provider selector. */
  label: string;
  /** The compose profile that deploys this provider's services. */
  profile: string;
  /** Compose services this provider deploys — the recreate scope. */
  services: readonly string[];
  /** Env keys this provider owns in state/stack.env. */
  envKeys: readonly string[];
  /**
   * Secret files to seed empty at install (ensureSecrets) — delegated
   * credentials and generated placeholders that Compose declares alike.
   * Compose fails CONTAINER CREATION outright when a declared secret's
   * source file is missing, so every declared file must exist even while
   * the addon is off.
   */
  secrets: readonly string[];
  /**
   * Does this provider, AS CONFIGURED, need the guardian's direct listener
   * to answer? Enablement is factored out — `computeGuardianIngressRequired`
   * below is the only caller and it checks the addon first.
   */
  guardianIngressRequired(env: Record<string, string | undefined>): boolean;
  /**
   * Lines for the security/exposure card. Ports and facts, never
   * unverified URLs (`describeRemoteExposure`'s rule). Enablement is
   * factored out, as above.
   */
  describeExposure(env: Record<string, string | undefined>): string[];
};

export const REMOTE_PROVIDERS: Record<string, RemoteProviderInfo> = {
  tailscale: {
    id: "tailscale",
    label: "Tailscale",
    profile: "addon.remote.tailscale",
    services: ["tunnel"],
    envKeys: ["OP_REMOTE_TARGET", "OP_REMOTE_PUBLIC", "OP_REMOTE_HOSTNAME"],
    secrets: ["ts_authkey"],
    guardianIngressRequired: (env) =>
      remoteRequiresGuardianIngress(true, readRemoteAccessConfig(env).target),
    // The workspace port comes from the SAME env this reads, so a relocated
    // port is disclosed at the number actually published.
    describeExposure: (env) =>
      describeRemoteExposure(
        readRemoteAccessConfig(env),
        true,
        resolveEnvPort("OP_WORKSPACE_PORT", DEFAULT_WORKSPACE_PORT, env),
      ),
  },
};

/**
 * Tailscale is the default variant: `resolveActiveProfiles` falls back to
 * this profile for an enabled `remote` with no stored selection, which is
 * what keeps a bare hand-edited `OP_ENABLED_ADDONS=remote` deploying the
 * tunnel exactly as it did before the profile was renamed from
 * `addon.remote` (remote-access-providers.md §2/§7).
 */
export const DEFAULT_REMOTE_PROVIDER_ID = "tailscale";
export const DEFAULT_REMOTE_PROFILE = REMOTE_PROVIDERS[DEFAULT_REMOTE_PROVIDER_ID].profile;

// ── Selection ────────────────────────────────────────────────────────────

/**
 * Which provider `OP_REMOTE_PROFILE` selects, defaulting to Tailscale for an
 * absent, blank, or unrecognized value. Unrecognized is deliberately the
 * default rather than an error: the selection is written through
 * `setAddonProfileSelection`, which validates against the compose-declared
 * profiles, so an unknown stored value means a hand edit — and the safe
 * reading of a hand edit this code cannot interpret is the same one a fresh
 * install gets.
 */
export function selectedRemoteProviderId(env: Record<string, string | undefined>): string {
  const selection = canonicalAddonProfileSelection("remote", env.OP_REMOTE_PROFILE ?? "");
  if (!selection) return DEFAULT_REMOTE_PROVIDER_ID;
  const match = Object.values(REMOTE_PROVIDERS).find((p) => p.profile === selection);
  return match?.id ?? DEFAULT_REMOTE_PROVIDER_ID;
}

export function selectedRemoteProvider(
  env: Record<string, string | undefined>,
): RemoteProviderInfo {
  return REMOTE_PROVIDERS[selectedRemoteProviderId(env)];
}

/** Whether the `remote` addon is enabled, from the same env record callers already hold. */
export function remoteAddonEnabled(env: Record<string, string | undefined>): boolean {
  return parseEnabledAddons(env.OP_ENABLED_ADDONS).includes("remote");
}

// ── The one guardian-ingress writer ──────────────────────────────────────

/**
 * True when the `remote` addon is enabled AND its selected provider, as
 * configured, needs the guardian's direct listener to answer. The ONLY
 * input `resolveAccessEnv`'s `guardianIngressRequired` option should ever
 * be fed.
 *
 * This CREATES the single-writer property rather than preserving one:
 * before the registry, `remoteRequiresGuardianIngress(enabled, target)` was
 * computed independently at three call sites (access-apply.ts, setup.ts,
 * remote-apply.ts), each re-deriving enablement and target its own way — a
 * dispersal a second provider would have tripled. All three now call this,
 * with whatever env snapshot they already hold, so "who can require
 * ingress" has one answer per snapshot.
 */
export function computeGuardianIngressRequired(
  env: Record<string, string | undefined>,
): boolean {
  if (!remoteAddonEnabled(env)) return false;
  return selectedRemoteProvider(env).guardianIngressRequired(env);
}

/**
 * Exposure lines for the selected provider, empty when the addon is off —
 * an addon that is off opens nothing, regardless of what its config says.
 */
export function describeSelectedRemoteExposure(
  env: Record<string, string | undefined>,
): string[] {
  if (!remoteAddonEnabled(env)) return [];
  return selectedRemoteProvider(env).describeExposure(env);
}
