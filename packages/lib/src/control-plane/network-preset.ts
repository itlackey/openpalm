/**
 * Network access preset resolver (#563).
 *
 * A single "network access" choice bundles bind-address exposure, OpenCode
 * Basic auth, and mDNS advertisement intent into one operator-facing decision
 * instead of four independently-tunable env vars. This module is the ONLY
 * place that knows the preset → env-var mapping; the wizard, the CLI headless
 * spec path, and the admin "detect current preset" surface all resolve
 * through it so they can never drift from each other.
 *
 * Browser-safe: this module imports ONLY `isLoopback`, `collectBindAddressWarnings`,
 * and `isRemoteSetupAllowed` from `./bind-warning.js` — no `node:*` imports and
 * never `./mdns-responder.js` (which pulls in `node:dgram`). The wizard
 * (packages/ui, a browser bundle) imports this module directly via the
 * `@openpalm/lib/control-plane/network-preset.js` subpath, precedent:
 * `provider-constants.ts`.
 *
 * D1 (mDNS mechanism): per-preset mDNS is delivered entirely by the #488 host
 * mDNS responder (`mdns-responder.ts`), which gates advertisement on exactly
 * the bind vars this resolver writes (`OP_ASSISTANT_BIND_ADDRESS` for the
 * assistant name, `OP_BIND_ADDRESS` for the guardian name). This resolver only
 * exposes `assistantMdns`/`guardianMdns` INTENT flags mirroring those gates —
 * it never touches mDNS config directly. `network-preset.test.ts` T7 pins the
 * two together so they can never silently diverge.
 *
 * D4 (managed key matrix): every preset writes ALL of `OP_BIND_ADDRESS`,
 * `OP_ASSISTANT_BIND_ADDRESS`, `OP_CLIENT_BIND_ADDRESS`, `OP_VOICE_BIND_ADDRESS`,
 * and `OPENCODE_AUTH` explicitly (loopback rather than "leave unset"), so
 * switching between presets always converges regardless of prior state.
 * `OP_CHAT_BIND_ADDRESS` / `OP_API_BIND_ADDRESS` are deliberately NOT managed —
 * those are listeners inside the guardian container, fail-closed
 * API-key-authenticated, so they are left to ride the `OP_BIND_ADDRESS`
 * cascade (guardian-protected exposure is the intended behavior under
 * shared-guardian). `GUARDIAN_DIRECT_INGRESS` is never touched by any preset —
 * presets configure exposure, not ingress enablement.
 */
import { isLoopback, collectBindAddressWarnings } from "./bind-warning.js";

// ── Preset identity ──────────────────────────────────────────────────────

export type NetworkAccessPreset = "this-pc" | "home-password" | "home-open" | "shared-guardian";

export const NETWORK_ACCESS_PRESETS: readonly NetworkAccessPreset[] = [
  "this-pc",
  "home-password",
  "home-open",
  "shared-guardian",
];

/** Single source of copy for the wizard, the admin tab, and warning text. */
export const NETWORK_PRESET_LABELS: Record<NetworkAccessPreset, string> = {
  "this-pc": "This PC only",
  "home-password": "Home network, with password",
  "home-open": "Home network, open access",
  "shared-guardian": "Shared network, guardian protected",
};

export function isNetworkAccessPreset(value: unknown): value is NetworkAccessPreset {
  return typeof value === "string" && (NETWORK_ACCESS_PRESETS as readonly string[]).includes(value);
}

// ── Resolution ────────────────────────────────────────────────────────────

const LOOPBACK_DEFAULT = "127.0.0.1";
const LAN_VALUE = "0.0.0.0";

/** Managed bind-address env keys every preset writes explicitly. */
const MANAGED_BIND_KEYS = [
  "OP_BIND_ADDRESS",
  "OP_ASSISTANT_BIND_ADDRESS",
  "OP_CLIENT_BIND_ADDRESS",
  "OP_VOICE_BIND_ADDRESS",
] as const;

export type NetworkPresetEnv = {
  OP_BIND_ADDRESS: string;
  OP_ASSISTANT_BIND_ADDRESS: string;
  OP_CLIENT_BIND_ADDRESS: string;
  OP_VOICE_BIND_ADDRESS: string;
  OPENCODE_AUTH: "true" | "false";
};

export type NetworkPresetResolution = {
  preset: NetworkAccessPreset;
  env: NetworkPresetEnv;
  /** Secret value for knowledge/secrets/op_opencode_password — home-password only. */
  opencodePassword?: string;
  /** Intent flags; equivalence to resolveMdnsStatus() is pinned by test T7. */
  assistantMdns: boolean;
  guardianMdns: boolean;
};

const ALL_LOOPBACK: NetworkPresetEnv = {
  OP_BIND_ADDRESS: LOOPBACK_DEFAULT,
  OP_ASSISTANT_BIND_ADDRESS: LOOPBACK_DEFAULT,
  OP_CLIENT_BIND_ADDRESS: LOOPBACK_DEFAULT,
  OP_VOICE_BIND_ADDRESS: LOOPBACK_DEFAULT,
  OPENCODE_AUTH: "false",
};

/**
 * Resolve one of the four network access presets into its complete managed
 * env row + mDNS intent flags. Throws on a password-contract violation
 * (missing/empty password for `home-password`, or a password supplied for any
 * other preset) — these are operator errors, not silent drops.
 */
export function resolveNetworkPreset(
  preset: NetworkAccessPreset,
  opts?: { opencodePassword?: string },
): NetworkPresetResolution {
  const password = opts?.opencodePassword;

  if (preset === "home-password") {
    if (!password) {
      throw new Error(
        'network.opencodePassword is required for the "home-password" network access preset.',
      );
    }
  } else if (password) {
    throw new Error(
      `network.opencodePassword must not be supplied for the "${preset}" network access preset.`,
    );
  }

  switch (preset) {
    case "this-pc":
      return { preset, env: { ...ALL_LOOPBACK }, assistantMdns: false, guardianMdns: false };
    case "home-password":
      return {
        preset,
        env: { ...ALL_LOOPBACK, OP_ASSISTANT_BIND_ADDRESS: LAN_VALUE, OPENCODE_AUTH: "true" },
        opencodePassword: password,
        assistantMdns: true,
        guardianMdns: false,
      };
    case "home-open":
      return {
        preset,
        env: { ...ALL_LOOPBACK, OP_ASSISTANT_BIND_ADDRESS: LAN_VALUE },
        assistantMdns: true,
        guardianMdns: false,
      };
    case "shared-guardian":
      return {
        preset,
        env: { ...ALL_LOOPBACK, OP_BIND_ADDRESS: LAN_VALUE },
        assistantMdns: false,
        guardianMdns: true,
      };
    default:
      throw new Error(`Unknown network access preset: ${String(preset)}`);
  }
}

// ── Detection ─────────────────────────────────────────────────────────────

/**
 * Per-service binds whose compose host-port default NESTS `${OP_BIND_ADDRESS}`
 * (core.compose.yml OP_CLIENT / services.compose.yml OP_VOICE:
 * `${OP_X_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}`). An unset value
 * therefore inherits the GLOBAL bind, not loopback. `OP_ASSISTANT_BIND_ADDRESS`
 * is deliberately absent — its host-port line defaults straight to 127.0.0.1
 * with no OP_BIND_ADDRESS fallback.
 */
const OP_BIND_CASCADING_KEYS: ReadonlySet<string> = new Set([
  "OP_CLIENT_BIND_ADDRESS",
  "OP_VOICE_BIND_ADDRESS",
]);

function boundValue(env: Record<string, string | undefined>, key: (typeof MANAGED_BIND_KEYS)[number]): string {
  const raw = env[key]?.trim();
  if (raw) return raw;
  // Mirror the compose cascade so detection sees the SAME exposure the stack
  // actually gets: an unset cascading bind inherits OP_BIND_ADDRESS (only then
  // loopback), so `OP_BIND_ADDRESS=0.0.0.0` alone reads as client/voice exposed
  // (drift → "custom" + loud warning), not a clean shared-guardian.
  if (OP_BIND_CASCADING_KEYS.has(key)) {
    const globalBind = env.OP_BIND_ADDRESS?.trim();
    if (globalBind) return globalBind;
  }
  return LOOPBACK_DEFAULT;
}

function isExposed(env: Record<string, string | undefined>, key: (typeof MANAGED_BIND_KEYS)[number]): boolean {
  return !isLoopback(boundValue(env, key));
}

function isAuthOn(env: Record<string, string | undefined>): boolean {
  const v = (env.OPENCODE_AUTH ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Reverse the resolver: given a (possibly hand-edited) env record, identify
 * which preset it matches, if any. Unset managed keys are treated as the
 * compose loopback default. Unmanaged keys (e.g. `OP_CHAT_BIND_ADDRESS`) are
 * ignored entirely — they are reported by `collectNetworkExposureWarnings`
 * instead, never by detection. Returns `null` on drift (a combination no
 * preset produces), which the caller reports as "custom".
 */
export function detectNetworkPreset(
  env: Record<string, string | undefined>,
): NetworkAccessPreset | null {
  const globalExposed = isExposed(env, "OP_BIND_ADDRESS");
  const assistantExposed = isExposed(env, "OP_ASSISTANT_BIND_ADDRESS");
  const clientExposed = isExposed(env, "OP_CLIENT_BIND_ADDRESS");
  const voiceExposed = isExposed(env, "OP_VOICE_BIND_ADDRESS");
  const authOn = isAuthOn(env);

  if (!globalExposed && !assistantExposed && !clientExposed && !voiceExposed && !authOn) {
    return "this-pc";
  }
  if (!globalExposed && assistantExposed && !clientExposed && !voiceExposed) {
    return authOn ? "home-password" : "home-open";
  }
  if (globalExposed && !assistantExposed && !clientExposed && !voiceExposed && !authOn) {
    return "shared-guardian";
  }
  return null;
}

// ── Env-combination validation ───────────────────────────────────────────

/**
 * Validate a target preset against the HOST PROCESS env (as opposed to
 * stack.env) it will be layered under. Compose gives process env precedence
 * over `--env-file`, so a leftover `OP_ASSISTANT_BIND_ADDRESS=0.0.0.0` in the
 * host process would silently defeat the shared-guardian hard-pin even though
 * the resolver correctly writes the loopback row to stack.env. Only
 * shared-guardian has a combination to guard against — the other three
 * presets never depend on the assistant staying loopback.
 */
export function validateNetworkPresetEnv(
  preset: NetworkAccessPreset,
  env: Record<string, string | undefined>,
): { valid: boolean; errors: string[] } {
  if (preset !== "shared-guardian") return { valid: true, errors: [] };
  if (isExposed(env, "OP_ASSISTANT_BIND_ADDRESS")) {
    return {
      valid: false,
      errors: [
        `The "shared-guardian" network access preset requires the assistant to stay loopback-only, but the current environment already exposes OP_ASSISTANT_BIND_ADDRESS="${env.OP_ASSISTANT_BIND_ADDRESS}". Unset it (or set it to 127.0.0.1) in the host process environment before switching to shared-guardian.`,
      ],
    };
  }
  return { valid: true, errors: [] };
}

// ── Warning composition (D9) ─────────────────────────────────────────────

/** The env var shown as the deliberate-exposure detail for each preset's line. */
function presetExposureLine(preset: NetworkAccessPreset): string {
  switch (preset) {
    case "home-password":
      return (
        `${NETWORK_PRESET_LABELS["home-password"]} is configured — the assistant is reachable from ` +
        `other devices on your network and requires the sign-in password you set ` +
        `(env: OP_ASSISTANT_BIND_ADDRESS).`
      );
    case "home-open":
      return (
        `${NETWORK_PRESET_LABELS["home-open"]} is configured — the assistant is reachable from any ` +
        `device on your network WITHOUT a password (env: OP_ASSISTANT_BIND_ADDRESS). Anyone on this ` +
        `network can use it.`
      );
    case "shared-guardian":
      return (
        `${NETWORK_PRESET_LABELS["shared-guardian"]} is configured — the guardian's protected front ` +
        `door is reachable from your network (env: OP_BIND_ADDRESS); the assistant itself stays ` +
        `private on this PC (loopback, 127.0.0.1).`
      );
    case "this-pc":
      return "";
  }
}

/** Force the managed keys back to their loopback default so collectBindAddressWarnings skips them. */
function suppressManagedKeys(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const copy = { ...env };
  for (const key of MANAGED_BIND_KEYS) copy[key] = LOOPBACK_DEFAULT;
  return copy;
}

/**
 * Compose the operator-facing exposure warning list for `env`. When `env`
 * exactly matches a preset row, the managed-var noise collapses into ONE
 * preset-framed line (informational — this exposure was deliberately
 * configured), plus per-var warnings for any non-loopback var OUTSIDE the
 * managed set (e.g. a hand-set `OP_CHAT_BIND_ADDRESS`) and the unchanged
 * `OP_ALLOW_REMOTE_SETUP` line. When nothing matches (drifted/custom env),
 * the full per-var list from `collectBindAddressWarnings` is returned
 * unchanged — unexplained exposure stays loud.
 */
export function collectNetworkExposureWarnings(
  env: Record<string, string | undefined>,
): string[] {
  const preset = detectNetworkPreset(env);
  const warnings: string[] = [];

  if (preset && preset !== "this-pc") {
    warnings.push(presetExposureLine(preset));
  }

  const effectiveEnv = preset ? suppressManagedKeys(env) : env;
  warnings.push(...collectBindAddressWarnings(effectiveEnv));

  return warnings;
}
