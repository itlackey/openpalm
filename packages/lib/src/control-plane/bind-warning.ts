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

/** Wildcard binds — these already answer on loopback as well as everything else. */
function isWildcardBind(value: string): boolean {
  const v = value.trim();
  return v === "0.0.0.0" || v === "::" || v === "";
}

/**
 * Does the workspace port need its own loopback publish?
 *
 * `core.compose.yml` publishes OpenCode's web UI on the UI's own interface,
 * `${OP_UI_BIND_ADDRESS:-127.0.0.1}:3820`. Loopback and the wildcard both
 * already answer 127.0.0.1. A CONCRETE address does not — so on a host bound
 * to, say, 192.168.0.201, nothing listens on 127.0.0.1:3820 and the desktop
 * window (whose page is on localhost) frames a dead address. LAN browsers are
 * unaffected; only the local operator loses the workspace, on their own
 * machine.
 *
 * True here means `workspace.compose.loopback.yml` is added to the compose
 * file list, publishing the port a second time on 127.0.0.1. The rule, stated
 * once: the configured bind address ADDS interfaces, it never subtracts
 * loopback.
 *
 * The workspace cannot simply be advertised at the LAN address instead — it is
 * authenticated by the session cookie, and cookies are scoped by host, not
 * port, so it must be fronted on the same hostname as the page framing it
 * (routes/(app)/advanced/embeddable.ts).
 */
export function needsWorkspaceLoopbackPublish(uiBindAddress: string | undefined): boolean {
  const v = (uiBindAddress ?? "").trim();
  if (v === "") return false;
  return !isLoopback(v) && !isWildcardBind(v);
}

/**
 * What counts as "on" for a binary opt-in flag in stack.env or the process env.
 *
 * Every such flag — OP_TRUSTED_PROXY, OP_ALLOW_REMOTE_SETUP,
 * OP_VOICE_LAN_ACCESS — accepted the same three spellings via its own inline
 * copy of this comparison, each written slightly differently (string chains and
 * a regex). Copies are how the next flag ends up quietly accepting a different
 * set from the others.
 *
 * Deliberately NOT shared with `access-toggles.ts`'s intent parser: that one is
 * tri-state (a stored boolean can be absent or unparseable, which is not the
 * same as false) and so needs a matching FALSE pattern too. These flags are
 * binary — anything that is not "on" is off.
 */
export function isEnabledFlag(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Opt-in: trust `x-forwarded-proto` / `Host` from a proxy in front of a
 * loopback-bound host UI, WITHOUT widening the listener.
 *
 * This is what every documented TLS topology actually needs. Tailscale Serve,
 * Caddy and nginx all connect to `127.0.0.1:3880`, so the two things required
 * are (a) the Host allowlist relaxed for the proxy's public name and (b)
 * adapter-node deriving its origin from the forwarded headers. Neither needs a
 * `0.0.0.0` bind — yet both were keyed off the same flag that opens one, so the
 * TLS guide had to add a compensating step telling operators to firewall the
 * plain-HTTP port the code had just opened for no reason.
 *
 * Admin capability still wins: a host admin surface is never reachable remotely,
 * proxy or not.
 */
export function isTrustedProxyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OP_ENABLE_ADMIN === '1' || env.OP_INSIDE_ELECTRON === '1') return false;
  return isEnabledFlag(env.OP_TRUSTED_PROXY);
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
  return isEnabledFlag(env.OP_ALLOW_REMOTE_SETUP);
}
