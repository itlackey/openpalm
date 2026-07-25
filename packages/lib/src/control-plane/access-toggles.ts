/**
 * Network access toggles — the operator-facing model, replacing the #563
 * preset enum.
 *
 * Presets fixed combinations. Capabilities compose. A four-value enum could not
 * express "network access on, guardian on for Slack, OpenAI API on, no
 * screening" — a combination people actually want — and every preset it *could*
 * express had to be reverse-engineered back out of the env by
 * `detectNetworkPreset`, because intent was only ever stored as its own
 * consequences.
 *
 * Each toggle maps to one derived line. There is nothing to detect: you read
 * the toggle.
 *
 * Progressive disclosure (the UI's concern, recorded here so the model is
 * legible): only `networkAccess` is always visible — that is the entire
 * surface for a home install. The other three live under Advanced.
 *
 * The guardian toggles are deliberately NOT gated on "a guardian-backed
 * integration is enabled". Publishing a front door is a statement of intent,
 * and `performSetup` makes it true: `guardianOpenaiApi` enables the `api`
 * addon that serves the edge it publishes, and `guardianNetwork` falls back to
 * the credential-less `chat` portal when nothing else provides guardian
 * ingress. Gating the toggles instead would mean an operator who wants a
 * guardian front door has to guess which unrelated integration to enable
 * first.
 *
 * Browser-safe: no `node:*` imports. The wizard imports this directly via the
 * `@openpalm/lib/control-plane/access-toggles.js` subpath.
 */
import { isLoopback } from "./bind-warning.js";

// ── The model ─────────────────────────────────────────────────────────────

export type AccessToggles = {
  /**
   * The OpenPalm UI is reachable from the network. This is the whole
   * configuration surface for a home install — the front door a person opens.
   * OpenCode itself stays loopback and is reached through the UI's same-origin
   * `/oc` proxy, so turning this on publishes exactly one listener.
   */
  networkAccess: boolean;
  /**
   * Advanced: publish OpenCode's API directly, for a second desktop app or a
   * third-party OpenCode client. Always paired with generated Basic auth — see
   * {@link resolveAccessEnv}. The built-in client never uses this path, so
   * enabling it puts no credential or CORS grant on the default route.
   */
  assistantDirect: boolean;
  /** Publish the guardian's `/oc` front door for screened/audited clients. */
  guardianNetwork: boolean;
  /** Publish the guardian's OpenAI/Anthropic-compatible edge. */
  guardianOpenaiApi: boolean;
};

/** Everything closed. A fresh install is reachable only from the machine it is on. */
export const ACCESS_TOGGLE_DEFAULTS: AccessToggles = {
  networkAccess: false,
  assistantDirect: false,
  guardianNetwork: false,
  guardianOpenaiApi: false,
};

export const ACCESS_TOGGLE_KEYS = [
  "networkAccess",
  "assistantDirect",
  "guardianNetwork",
  "guardianOpenaiApi",
] as const satisfies readonly (keyof AccessToggles)[];

/** Single source of operator-facing copy for the wizard and the admin tab. */
export const ACCESS_TOGGLE_LABELS: Record<keyof AccessToggles, string> = {
  networkAccess: "Let other devices on my network use the assistant",
  assistantDirect: "Allow direct connections to the assistant API",
  guardianNetwork: "Let other devices reach the guardian",
  guardianOpenaiApi: "Enable the OpenAI-compatible API",
};

export const ACCESS_TOGGLE_DESCRIPTIONS: Record<keyof AccessToggles, string> = {
  networkAccess:
    "Open the assistant in a browser from your phone, tablet, or another computer. Everyone still signs in with your password.",
  assistantDirect:
    "For other apps that speak OpenCode directly. Uses its own generated key, shown in the dashboard — not your sign-in password.",
  guardianNetwork:
    "Apps and devices connect through the guardian, which screens, logs, and rate-limits everything it forwards.",
  guardianOpenaiApi:
    "Lets tools that expect an OpenAI-style API talk to your assistant, using an API key you issue.",
};

// ── Derivation ────────────────────────────────────────────────────────────

const LOOPBACK = "127.0.0.1";
const LAN = "0.0.0.0";

/**
 * The complete generated env row. Every value is written explicitly on every
 * deploy — there is no cascade and no "unset means inherit", which is what made
 * the previous model's failures undiagnosable ("unset" meant *inherit the
 * global bind* for four listeners and *loopback* for one, in the same file).
 */
export type AccessEnv = {
  OP_UI_BIND_ADDRESS: string;
  OP_ASSISTANT_BIND_ADDRESS: string;
  OP_GUARDIAN_BIND_ADDRESS: string;
  OP_API_BIND_ADDRESS: string;
  OPENCODE_AUTH: "true" | "false";
  /**
   * The guardian 404s its entire direct listener unless this is on, so it
   * tracks `guardianNetwork` exactly — publishing a port to a listener that
   * refuses every request was the previous model's sharpest foot-gun
   * (`api/connections/pairing` told operators to hand-edit stack.env and
   * restart the guardian when their paired device 404'd).
   */
  GUARDIAN_DIRECT_INGRESS: "true" | "false";
};

/** The generated keys, for callers that need to strip or diff them. */
export const ACCESS_ENV_KEYS = [
  "OP_UI_BIND_ADDRESS",
  "OP_ASSISTANT_BIND_ADDRESS",
  "OP_GUARDIAN_BIND_ADDRESS",
  "OP_API_BIND_ADDRESS",
  "OPENCODE_AUTH",
  "GUARDIAN_DIRECT_INGRESS",
] as const satisfies readonly (keyof AccessEnv)[];

/**
 * Resolve toggles into the generated env row.
 *
 * `OPENCODE_AUTH` tracks `assistantDirect` exactly: OpenCode authenticates iff
 * it is published. When it is not published there is no network-reachable
 * surface to authenticate, and the UI's proxy reaches it over loopback.
 */
export function resolveAccessEnv(toggles: AccessToggles): AccessEnv {
  return {
    OP_UI_BIND_ADDRESS: toggles.networkAccess ? LAN : LOOPBACK,
    OP_ASSISTANT_BIND_ADDRESS: toggles.assistantDirect ? LAN : LOOPBACK,
    OP_GUARDIAN_BIND_ADDRESS: toggles.guardianNetwork ? LAN : LOOPBACK,
    OP_API_BIND_ADDRESS: toggles.guardianOpenaiApi ? LAN : LOOPBACK,
    OPENCODE_AUTH: toggles.assistantDirect ? "true" : "false",
    GUARDIAN_DIRECT_INGRESS: toggles.guardianNetwork ? "true" : "false",
  };
}

/**
 * True when `assistantDirect` requires a generated OpenCode key. Callers mint
 * one rather than asking the operator to invent it — the human-facing
 * credential is the UI login password in every configuration, without
 * exception.
 */
export function requiresAssistantKey(toggles: AccessToggles): boolean {
  return toggles.assistantDirect;
}

// ── Reading current state ────────────────────────────────────────────────

/**
 * Resolve the EFFECTIVE bind for one listener, mirroring the retired compose
 * cascade's precedence exactly: an explicitly-set service key always wins, and
 * a legacy root is consulted only when the specific key is absent.
 *
 * The precedence matters for safety, not tidiness. The old shared-guardian row
 * was `OP_BIND_ADDRESS=0.0.0.0` with `OP_UI_BIND_ADDRESS=127.0.0.1` written
 * explicitly — compose's `${OP_UI_BIND_ADDRESS:-${OP_BIND_ADDRESS:-...}}` used
 * the specific value, so the UI stayed loopback. Reading that row with a plain
 * OR would report `networkAccess: true`, and the next rerun or host-stack save
 * would write `0.0.0.0` back — publishing a surface the operator had
 * deliberately kept private.
 */
function effectiveBind(
  env: Record<string, string | undefined>,
  specificKey: string,
  legacyKeys: readonly string[] = [],
): string {
  const specific = env[specificKey]?.trim();
  if (specific) return specific;
  for (const key of legacyKeys) {
    const legacy = env[key]?.trim();
    if (legacy) return legacy;
  }
  return LOOPBACK;
}

function isOpen(
  env: Record<string, string | undefined>,
  specificKey: string,
  legacyKeys: readonly string[] = [],
): boolean {
  return !isLoopback(effectiveBind(env, specificKey, legacyKeys));
}

/**
 * Read the toggles back out of an env record, for display and for pre-filling
 * a rerun. Unlike the preset model this is a direct read, not an inference —
 * an env that matches no combination cannot exist, because every combination
 * is representable.
 *
 * Legacy rows are mapped rather than rejected, using the cascade's own
 * precedence (see {@link effectiveBind}). `OP_BIND_ADDRESS` was the cascade
 * root for the UI, guardian and API listeners; `OP_CHAT_BIND_ADDRESS` was the
 * second host port onto the guardian's single OpenAI-compatible listener.
 * `OP_ASSISTANT_BIND_ADDRESS` never cascaded — its compose line defaulted
 * straight to loopback — so it has no legacy fallback here.
 */
export function readAccessToggles(env: Record<string, string | undefined>): AccessToggles {
  return {
    networkAccess: isOpen(env, "OP_UI_BIND_ADDRESS", ["OP_BIND_ADDRESS"]),
    assistantDirect: isOpen(env, "OP_ASSISTANT_BIND_ADDRESS"),
    guardianNetwork: isOpen(env, "OP_GUARDIAN_BIND_ADDRESS", ["OP_BIND_ADDRESS"]),
    guardianOpenaiApi: isOpen(env, "OP_API_BIND_ADDRESS", ["OP_CHAT_BIND_ADDRESS", "OP_BIND_ADDRESS"]),
  };
}

/**
 * Materialize the flat generated row from a legacy env, for the one-time
 * upgrade migration. Returns the complete {@link AccessEnv} the retired
 * cascade would have produced, so an existing install keeps exactly the
 * exposure it had.
 */
export function migrateLegacyAccessEnv(env: Record<string, string | undefined>): AccessEnv {
  return resolveAccessEnv(readAccessToggles(env));
}

/** Env keys the flat model retires. Removed by the upgrade migration. */
export const RETIRED_BIND_KEYS = [
  "OP_BIND_ADDRESS",
  "OP_CHAT_BIND_ADDRESS",
  "OP_VOICE_BIND_ADDRESS",
] as const;

/** Narrow arbitrary JSON to a complete toggle record, defaulting anything absent. */
export function coerceAccessToggles(value: unknown): AccessToggles {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const result = { ...ACCESS_TOGGLE_DEFAULTS };
  for (const key of ACCESS_TOGGLE_KEYS) {
    if (typeof source[key] === "boolean") result[key] = source[key] as boolean;
  }
  return result;
}

// ── Operator-facing exposure summary ─────────────────────────────────────

/**
 * One line per deliberately-opened door, for the startup log and the admin
 * surface. Replaces the per-variable warning matrix: exposure is now a
 * property of a toggle the operator set, so it is reported as a fact rather
 * than diagnosed as possible drift.
 */
export function describeAccessExposure(toggles: AccessToggles): string[] {
  const lines: string[] = [];
  if (toggles.networkAccess) {
    lines.push(
      "The OpenPalm UI is reachable from your network. Everyone signs in with the UI password.",
    );
  }
  if (toggles.assistantDirect) {
    lines.push(
      "The assistant API is published directly with a generated key. Plain-HTTP Basic auth is readable "
        + "by anything already on the network — prefer the guardian on a network you do not control.",
    );
  }
  if (toggles.guardianNetwork) {
    lines.push("The guardian's front door is reachable from your network.");
  }
  if (toggles.guardianOpenaiApi) {
    lines.push("The OpenAI-compatible API is reachable from your network and requires an API key.");
  }
  return lines;
}
