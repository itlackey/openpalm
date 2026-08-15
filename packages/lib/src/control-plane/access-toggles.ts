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
 * and the toggle itself makes it true: either guardian toggle is a
 * `guardianRequired` reason (guardian-required.ts), which activates the
 * guardian's own compose profile — no integration is enabled on the
 * operator's behalf. Gating the toggles instead would mean an operator who
 * wants a guardian front door has to guess which unrelated integration to
 * enable first.
 *
 * Browser-safe: no `node:*` imports. The wizard imports this directly via the
 * `@openpalm/lib/control-plane/access-toggles.js` subpath.
 */
import { isLoopback } from "./bind-warning.js";
import type { RemoteTarget } from "./remote-access.js";

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
   * third-party OpenCode client. Bind address only — OpenCode's generated
   * Basic auth is always on regardless (clients use the system key, revealable
   * from Connections). The built-in client never uses this path, so enabling
   * it puts no credential or CORS grant on the default route.
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
  /**
   * The guardian 404s its entire direct listener unless this is on, so it
   * tracks `guardianNetwork` exactly — publishing a port to a listener that
   * refuses every request was the previous model's sharpest foot-gun
   * (`api/connections/pairing` told operators to hand-edit stack.env and
   * restart the guardian when their paired device 404'd).
   */
  GUARDIAN_DIRECT_INGRESS: "true" | "false";
};

/**
 * Where each toggle's INTENT is stored, as a boolean, alongside the generated
 * row it produces.
 *
 * Intent used to be stored only as its own consequences — four bind addresses —
 * and read back by inferring "is this loopback?". That is the root cause the
 * churn history keeps returning to, because inference and Compose's own
 * precedence could disagree, in both directions:
 *
 *   - a shared-guardian row (`OP_BIND_ADDRESS=0.0.0.0` with an explicit
 *     `OP_UI_BIND_ADDRESS=127.0.0.1`) read back as networkAccess:true, and the
 *     next save made that reading REAL — silently publishing a surface the
 *     operator had deliberately kept private;
 *   - a restored backup or hand edit could show every toggle ON while Compose
 *     published loopback for all of them.
 *
 * A stored boolean cannot disagree with itself. The derived row remains
 * generated output: hand edits to it are overwritten on the next save.
 */
export const ACCESS_INTENT_KEYS: Record<keyof AccessToggles, string> = {
  networkAccess: "OP_ACCESS_NETWORK",
  assistantDirect: "OP_ACCESS_ASSISTANT_DIRECT",
  guardianNetwork: "OP_ACCESS_GUARDIAN",
  guardianOpenaiApi: "OP_ACCESS_OPENAI_API",
};

/** Serialize toggles into their stored-intent keys. */
export function resolveAccessIntentEnv(toggles: AccessToggles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ACCESS_TOGGLE_KEYS) {
    out[ACCESS_INTENT_KEYS[key]] = toggles[key] ? "true" : "false";
  }
  return out;
}

/** The generated keys, for callers that need to strip or diff them. */
export const ACCESS_ENV_KEYS = [
  "OP_UI_BIND_ADDRESS",
  "OP_ASSISTANT_BIND_ADDRESS",
  "OP_GUARDIAN_BIND_ADDRESS",
  "OP_API_BIND_ADDRESS",
  "GUARDIAN_DIRECT_INGRESS",
] as const satisfies readonly (keyof AccessEnv)[];

/**
 * Resolve toggles into the generated env row.
 *
 * OpenCode's own Basic auth is NOT derived here: it is always on (the
 * entrypoint unconditionally exports the generated key), so `assistantDirect`
 * means exactly one thing — whether the port is published.
 *
 * `opts.guardianIngressRequired` is the ONE place another feature may add a
 * reason for `GUARDIAN_DIRECT_INGRESS` to be "true" without also opening the
 * LAN bind — the `remote` addon tunnels to the guardian over `portal_net`,
 * never through `OP_GUARDIAN_BIND_ADDRESS`, so it needs the direct listener
 * to answer while that bind stays loopback. It is deliberately NOT threaded
 * into `OP_GUARDIAN_BIND_ADDRESS`: that bind is the actual LAN firewall, and
 * `guardianNetwork` — the toggle an operator reads as "let other devices on
 * my network reach the guardian" — must stay its ONLY source. Wiring a second
 * feature into it would mean turning on `remote` silently opens the guardian
 * to every device on the LAN, which is not what `remote` asked for and not
 * what the toggle's own label promises.
 *
 * The parameter is optional, and every existing call site that omits it gets
 * today's exact behaviour (`GUARDIAN_DIRECT_INGRESS` tied to `guardianNetwork`
 * alone) — this is a regression guard, not an implementation detail, because
 * this function has many callers across setup, config persistence and the
 * apply path that must not have to learn about `remote` to keep compiling.
 */
export function resolveAccessEnv(
  toggles: AccessToggles,
  opts: { guardianIngressRequired?: boolean } = {},
): AccessEnv {
  return {
    OP_UI_BIND_ADDRESS: toggles.networkAccess ? LAN : LOOPBACK,
    OP_ASSISTANT_BIND_ADDRESS: toggles.assistantDirect ? LAN : LOOPBACK,
    OP_GUARDIAN_BIND_ADDRESS: toggles.guardianNetwork ? LAN : LOOPBACK,
    OP_API_BIND_ADDRESS: toggles.guardianOpenaiApi ? LAN : LOOPBACK,
    GUARDIAN_DIRECT_INGRESS:
      toggles.guardianNetwork || opts.guardianIngressRequired ? "true" : "false",
  };
}

/**
 * True when the `remote` addon needs the guardian's direct listener to
 * ANSWER — i.e. it is enabled and tunnelling to the guardian at all.
 *
 * Lives here rather than in remote-access.ts because it feeds exactly one
 * thing: the `opts.guardianIngressRequired` half of {@link resolveAccessEnv}
 * above. Keeping it beside its only consumer means a reader of that function
 * finds the whole "who else can require ingress" story in one file, instead
 * of having to also open remote-access.ts to see where the boolean comes
 * from. `RemoteTarget` is imported as a type only, so this stays a
 * type-level coupling — no runtime import, no risk to the browser-safe
 * (no-`node:*`) contract this module shares with remote-access.ts.
 */
export function remoteRequiresGuardianIngress(enabled: boolean, target: RemoteTarget): boolean {
  return enabled && (target === "guardian" || target === "both");
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

const TRUE_RE = /^(true|1|yes|on)$/i;
const FALSE_RE = /^(false|0|no|off)$/i;

/** Read one stored intent boolean; `undefined` when absent or unparseable. */
function readIntent(
  env: Record<string, string | undefined>,
  key: keyof AccessToggles,
): boolean | undefined {
  const raw = env[ACCESS_INTENT_KEYS[key]]?.trim();
  if (!raw) return undefined;
  if (TRUE_RE.test(raw)) return true;
  if (FALSE_RE.test(raw)) return false;
  return undefined;
}

/**
 * Read the toggles back out of an env record, for display and for pre-filling
 * a rerun.
 *
 * Stored intent wins (see {@link ACCESS_INTENT_KEYS}). Inference from bind
 * addresses survives ONLY as the fallback for a row that predates the stored
 * keys — it is what the migration reads once to materialize them, and what a
 * hand-edited or restored-backup row falls back to until the next save. It is
 * no longer the normal read path, which is the point: inference is what could
 * disagree with Compose and then be made real by the next write.
 *
 * The legacy fallbacks live inside that inference. `OP_BIND_ADDRESS` was the
 * cascade root for the UI, guardian and API listeners; `OP_CHAT_BIND_ADDRESS`
 * was the second host port onto the guardian's OpenAI-compatible listener.
 * `OP_ASSISTANT_BIND_ADDRESS` never cascaded, so it has no legacy fallback.
 */
export function readAccessToggles(env: Record<string, string | undefined>): AccessToggles {
  return {
    networkAccess:
      readIntent(env, "networkAccess") ?? isOpen(env, "OP_UI_BIND_ADDRESS", ["OP_BIND_ADDRESS"]),
    assistantDirect:
      readIntent(env, "assistantDirect") ?? isOpen(env, "OP_ASSISTANT_BIND_ADDRESS"),
    guardianNetwork:
      readIntent(env, "guardianNetwork")
      ?? isOpen(env, "OP_GUARDIAN_BIND_ADDRESS", ["OP_BIND_ADDRESS"]),
    guardianOpenaiApi:
      readIntent(env, "guardianOpenaiApi")
      ?? isOpen(env, "OP_API_BIND_ADDRESS", ["OP_CHAT_BIND_ADDRESS", "OP_BIND_ADDRESS"]),
  };
}

/** True when every toggle's intent is stored, i.e. nothing is being inferred. */
export function hasStoredAccessIntent(env: Record<string, string | undefined>): boolean {
  return ACCESS_TOGGLE_KEYS.every((key) => readIntent(env, key) !== undefined);
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
