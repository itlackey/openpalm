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

/** Known per-service bind address env var names (mirrors compose files). */
const PER_SERVICE_BIND_VARS: readonly string[] = [
  "OP_ASSISTANT_BIND_ADDRESS",
  "OP_CLIENT_BIND_ADDRESS",
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
 * the other per-service vars (client/chat/api/voice) are never preset-managed
 * so they keep generic wording naming no preset.
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
 * Opt-in: allow the web UI (including the first-run setup wizard) to be reached
 * from a remote machine. When set, the UI server binds all interfaces and the
 * Host/Origin allowlist + the setup-localhost-only gate are relaxed.
 *
 * This deliberately reopens the owner-race the setup gate normally prevents, so
 * it is OFF by default and must be explicitly enabled by the operator. Reach the
 * UI over an SSH tunnel or a reverse proxy instead when you can.
 */
export function isRemoteSetupAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
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
    warnings.push(
      `${PRESET_FRAMING.OP_BIND_ADDRESS} exposure — OP_BIND_ADDRESS is set to "${globalBind}", exposing ` +
        `services on the host network interface, not just loopback. Ensure a firewall is in place if ` +
        `this host is reachable from untrusted networks.`,
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
        `setup wizard is no longer restricted to the host. Only use this on a trusted network behind a firewall.`,
    );
  }

  return warnings;
}
