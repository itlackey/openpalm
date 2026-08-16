/**
 * The host UI's network contract — ONE owner for "which port, which bind".
 *
 * These two questions were answered independently in seven places: an explicit
 * `--port`, `PORT`, `OP_HOST_UI_PORT` from live env, `OP_HOST_UI_PORT` from
 * persisted stack.env (honored by the CLI, ignored by Electron), three separate
 * `3880` constants, and inline `?? 3880` fallbacks in UI routes. Same home, two
 * harnesses, two answers — which is how a headless install could persist a
 * custom port that `openpalm` respected and the desktop app did not.
 *
 * Node.js-compatible only (no Bun.* APIs) so the Electron Node child can use it.
 */
import { STACK_DEFAULTS } from "./defaults.js";

/** The ONE host-UI port default. Every other site imports this. */
export const DEFAULT_HOST_UI_PORT = STACK_DEFAULTS.ports.hostUi;

/** The ONE published/container UI port default (what compose maps to the LAN). */
export const DEFAULT_PUBLISHED_UI_PORT = STACK_DEFAULTS.ports.ui;

/**
 * The ONE OpenCode workspace port default.
 *
 * `OP_WORKSPACE_PORT` is resolved by {@link resolveEnvPort} like every other
 * port in the tree — deliberately, after an attempt to give it a third
 * "unusable value means the listener is OFF" state. That could not hold: the
 * container publishes this port through compose's
 * `${OP_WORKSPACE_PORT:-3820}`, which substitutes the default for an EMPTY
 * value (so "off" silently stayed on) and interpolates `0`/junk straight into
 * a published-port spec (so "off" failed the whole stack instead). Compose
 * cannot gate a single port line behind a profile, so a working off-switch
 * would have needed a second variable. There is no off-switch for the UI port
 * or the assistant port either; this one behaves the same.
 */
export const DEFAULT_WORKSPACE_PORT = STACK_DEFAULTS.ports.workspace;

/**
 * Resolve one port env var: an explicit argument wins, then live process env,
 * then the home's persisted stack.env, then the default.
 *
 * Live-env-over-persisted is the important half: Electron's child env spread had
 * it INVERTED, so a value an operator exported before launching the desktop app
 * was silently overridden by the file, while the identical launch through
 * `openpalm` honored it. Every port question in the tree gets this same shape —
 * expressing it once means a change to the merge semantics (how an empty string
 * behaves, say) cannot land on some of the ports and miss the rest.
 *
 * Rejects anything a listener could not bind — zero, negative, fractional, out
 * of range — from BOTH the explicit argument and the env, falling through to
 * the default rather than returning it verbatim or throwing. `Number(x) ||
 * fallback` let a negative through, and the default is the more useful answer.
 */
export function resolveEnvPort(
  key: string,
  fallback: number,
  env: Record<string, string | undefined>,
  persistedEnv: Record<string, string | undefined> = {},
  explicit?: number,
): number {
  if (explicit !== undefined && isUsablePort(explicit)) return explicit;
  const merged = { ...persistedEnv, ...env };
  const raw = merged[key]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  // Held to the SAME bar as the explicit branch above. It used to accept any
  // positive finite number, so `70000` and `3820.5` came back verbatim from env
  // while being rejected as an explicit argument — one resolver with two
  // standards, in the module whose whole purpose is having one.
  return isUsablePort(parsed) ? parsed : fallback;
}

/** A number a listener can actually bind. */
function isUsablePort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** Resolve the host UI's listen port (`OP_HOST_UI_PORT`). */
export function resolveHostUiPort(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
  persistedEnv: Record<string, string | undefined> = {},
): number {
  return resolveEnvPort("OP_HOST_UI_PORT", DEFAULT_HOST_UI_PORT, env, persistedEnv, explicit);
}

/**
 * Resolve the PUBLISHED UI port (`OP_UI_PORT`) — the one compose maps onto the
 * LAN for the assistant container's UI co-process. Distinct question from
 * {@link resolveHostUiPort}: that is the port a host process listens on.
 */
export function resolvePublishedUiPort(
  env: Record<string, string | undefined>,
  persistedEnv: Record<string, string | undefined> = {},
): number {
  return resolveEnvPort("OP_UI_PORT", DEFAULT_PUBLISHED_UI_PORT, env, persistedEnv);
}

/**
 * The adapter-node listen configuration for a host UI child.
 *
 * `HOST` is always loopback for an admin-capable process: host admin is never
 * reachable remotely, and that is not weakened by any flag. `ORIGIN` is pinned
 * to the same loopback spelling so SvelteKit's own origin checks agree with the
 * bind.
 *
 * The one non-loopback case is a NON-admin, fully-installed home where the
 * operator explicitly opted into remote access. It sets the forwarded-header
 * names instead of pinning ORIGIN, because in that mode the browser's real
 * origin comes from the proxy.
 */
export type UiListenEnv = Record<
  "HOST" | "PORT" | "ORIGIN" | "HOST_HEADER" | "PROTOCOL_HEADER",
  string | undefined
>;

/** One loopback spelling, everywhere. */
export const UI_LOOPBACK_HOST = "127.0.0.1";

export function resolveUiListenEnv(opts: {
  port: number;
  /** True when this process advertises the host:* capability set. */
  admin: boolean;
  /** True only for an explicit remote-access opt-in on an installed home. */
  allowRemote: boolean;
  /**
   * Trust `Host`/`x-forwarded-proto` from a proxy WITHOUT widening the bind.
   * Every documented TLS topology (Tailscale Serve, Caddy, nginx) proxies to
   * loopback, so opening 0.0.0.0 for them was gratuitous — and the docs then had
   * to tell operators to firewall the port the code had just opened.
   */
  trustProxy?: boolean;
}): UiListenEnv {
  // Both non-admin opt-ins produce the SAME contract — derive the origin from
  // the forwarded headers rather than pinning it — and differ only in whether
  // the listener widens. Keeping them as one branch is what stops the header
  // names from being changed for the proxy case and missed for the remote one.
  if (!opts.admin && (opts.trustProxy || opts.allowRemote)) {
    return {
      HOST: opts.allowRemote ? "0.0.0.0" : UI_LOOPBACK_HOST,
      PORT: String(opts.port),
      HOST_HEADER: "host",
      PROTOCOL_HEADER: "x-forwarded-proto",
      ORIGIN: undefined,
    };
  }
  return {
    HOST: UI_LOOPBACK_HOST,
    PORT: String(opts.port),
    ORIGIN: `http://${UI_LOOPBACK_HOST}:${opts.port}`,
    HOST_HEADER: undefined,
    PROTOCOL_HEADER: undefined,
  };
}
