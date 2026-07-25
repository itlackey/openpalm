/**
 * Loopback predicates and the remote-setup opt-in.
 *
 * This module used to carry a per-variable exposure warning matrix
 * (`collectBindAddressWarnings`) that inspected six bind-address variables and
 * guessed whether each non-loopback value was deliberate. That existed because
 * exposure was only ever stored as its own consequences, so intent had to be
 * inferred back out of the env.
 *
 * With access toggles, exposure IS the stored intent: every bind is generated
 * from a toggle the operator set. Reporting it is a read, not a diagnosis —
 * see `describeAccessExposure` in `access-toggles.ts`.
 */

/** Loopback host spellings. Shared by mdns-responder, access-toggles, and the UI's Host allowlist. */
export function isLoopback(value: string): boolean {
  const v = value.trim();
  return v === "127.0.0.1" || v === "localhost" || v === "::1";
}

/**
 * True when the container-served OpenPalm UI is published off loopback.
 *
 * Read straight from the generated `OP_UI_BIND_ADDRESS`. There is no cascade
 * to mirror any more: every bind is written explicitly on every deploy, so an
 * absent value means loopback and nothing else.
 */
export function isUiLanExposed(env: Record<string, string | undefined>): boolean {
  const bind = env.OP_UI_BIND_ADDRESS?.trim() || "127.0.0.1";
  return !isLoopback(bind);
}

/**
 * Opt-in: allow a non-admin web UI to be reached from a remote machine. Admin
 * capability always wins over this flag so old Electron harnesses and inherited
 * shell env cannot weaken the host-only admin boundary. First-run setup remains
 * restricted to a loopback browser origin by the request hook.
 *
 * Distinct from the `networkAccess` toggle: that publishes the CONTAINER UI on
 * the LAN, which the UI's Host allowlist honours directly. This flag is for a
 * HOST process behind an operator-managed HTTPS proxy.
 */
export function isRemoteSetupAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OP_ENABLE_ADMIN === '1' || env.OP_INSIDE_ELECTRON === '1') return false;
  const v = env.OP_ALLOW_REMOTE_SETUP?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
