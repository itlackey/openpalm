/**
 * Startup warning for non-loopback bind addresses.
 *
 * When OP_BIND_ADDRESS is set to a non-loopback value (anything other than
 * 127.0.0.1, localhost, or ::1), services are exposed on the host network
 * interface. This helper produces a structured list of warning lines that
 * callers should log at WARN level so operators are aware.
 *
 * Per-service overrides (e.g. OP_CHAT_BIND_ADDRESS, OP_VOICE_BIND_ADDRESS)
 * are also checked and reported individually.
 */

import { GUARDIAN_INGRESS_ADDON_IDS } from "./addon-ids.js";

/**
 * True when OP_ENABLED_ADDONS names at least one guardian-ingress addon — i.e.
 * a guardian proxy is actually deployed in front of the exposed services.
 * Parses the comma-separated OP_ENABLED_ADDONS directly (no dependency on
 * addons.ts, to keep this module import-light and cycle-free).
 */
function hasGuardianIngress(env: Record<string, string | undefined>): boolean {
  const enabled = (env.OP_ENABLED_ADDONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return enabled.some((a) => GUARDIAN_INGRESS_ADDON_IDS.includes(a));
}

/** Known per-service bind address env var names (mirrors compose files). */
const PER_SERVICE_BIND_VARS: readonly string[] = [
  "OP_ASSISTANT_BIND_ADDRESS",
  "OP_UI_BIND_ADDRESS",
  "OP_CHAT_BIND_ADDRESS",
  "OP_API_BIND_ADDRESS",
  "OP_VOICE_BIND_ADDRESS",
];

/**
 * #563 D9 — per-var warnings lead with WHAT is exposed and which network
 * access preset (packages/lib/src/control-plane/network-preset.ts)
 * deliberately configures that exposure, so operators reading the log can
 * tell "I did this on purpose" from "something hand-edited this". Only
 * `OP_ASSISTANT_BIND_ADDRESS` (the Home network presets) and
 * `OP_BIND_ADDRESS` (the Shared network preset) are ever set by a preset;
 * the other per-service vars (ui/chat/api/voice) keep generic wording naming
 * no preset. OP_UI_BIND_ADDRESS is preset-managed too, but every preset pins it
 * to loopback, so it never actually surfaces a warning here.
 */
const PRESET_FRAMING: Record<string, string> = {
  OP_BIND_ADDRESS: "Shared network, guardian protected",
  OP_ASSISTANT_BIND_ADDRESS: "Home network",
};

/** Exported for reuse by mdns-responder.ts's bind-gating logic (#488). */
export function isLoopback(value: string): boolean {
  const v = value.trim();
  return v === "127.0.0.1" || v === "localhost" || v === "::1";
}

/**
 * Opt-in: allow a non-admin web UI to be reached from a remote machine. Admin
 * capability always wins over this flag so old Electron harnesses and inherited
 * shell env cannot weaken the host-only admin boundary. First-run setup remains
 * restricted to a loopback browser origin by the request hook.
 */
export function isRemoteSetupAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OP_ENABLE_ADMIN === '1' || env.OP_INSIDE_ELECTRON === '1') return false;
  const v = env.OP_ALLOW_REMOTE_SETUP?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Inspect `env` for non-loopback bind address settings and return one warning
 * line per problematic variable.  Returns an empty array when everything is
 * loopback (or unset, since the compose default is 127.0.0.1).
 *
 * @param env - The environment to inspect; typically `process.env`.
 */
export function collectBindAddressWarnings(
  env: Record<string, string | undefined>,
): string[] {
  const warnings: string[] = [];

  const globalBind = env.OP_BIND_ADDRESS;
  if (globalBind && !isLoopback(globalBind)) {
    // PR #564 r3566893095: "guardian protected" is only truthful when a
    // guardian-ingress addon is actually enabled. Without one, the exposed
    // OP_BIND_ADDRESS cascade (which nests into OP_UI_*/OP_VOICE_*) puts
    // raw services on the LAN with no guardian proxy in front — say so.
    warnings.push(
      hasGuardianIngress(env)
        ? `${PRESET_FRAMING.OP_BIND_ADDRESS} exposure — OP_BIND_ADDRESS is set to "${globalBind}", exposing ` +
            `services on the host network interface, not just loopback. Ensure a firewall is in place if ` +
            `this host is reachable from untrusted networks.`
        : `Unprotected LAN exposure — OP_BIND_ADDRESS is set to "${globalBind}" but no guardian-ingress addon ` +
            `is enabled, so services are exposed directly on the host network interface with no guardian proxy ` +
            `in front. Enable a guardian-ingress addon (chat/api/gateway/discord/slack) or keep this loopback-only.`,
    );
  }

  for (const key of PER_SERVICE_BIND_VARS) {
    const val = env[key];
    if (val && !isLoopback(val)) {
      const framing = PRESET_FRAMING[key];
      warnings.push(
        framing
          ? `${framing} exposure — ${key} is set to "${val}", exposing this service on the host network interface.`
          : `${key} is set to "${val}" — this service will be exposed on the host network interface.`,
      );
    }
  }

  if (isRemoteSetupAllowed(env)) {
    warnings.push(
      `OP_ALLOW_REMOTE_SETUP is enabled — the web UI is reachable from remote machines and the ` +
        `initial setup must already be complete. Only use this behind an operator-managed HTTPS proxy and firewall.`,
    );
  }

  return warnings;
}
