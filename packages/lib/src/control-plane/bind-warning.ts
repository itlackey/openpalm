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
  "OP_CHAT_BIND_ADDRESS",
  "OP_API_BIND_ADDRESS",
  "OP_VOICE_BIND_ADDRESS",
];

function isLoopback(value: string): boolean {
  const v = value.trim();
  return v === "127.0.0.1" || v === "localhost" || v === "::1";
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

  const globalBind = env["OP_BIND_ADDRESS"];
  if (globalBind && !isLoopback(globalBind)) {
    warnings.push(
      `OP_BIND_ADDRESS is set to "${globalBind}" — services will be exposed on the host network interface, not just loopback. ` +
        `Ensure a firewall is in place if this host is reachable from untrusted networks.`,
    );
  }

  for (const key of PER_SERVICE_BIND_VARS) {
    const val = env[key];
    if (val && !isLoopback(val)) {
      warnings.push(
        `${key} is set to "${val}" — this service will be exposed on the host network interface.`,
      );
    }
  }

  return warnings;
}
