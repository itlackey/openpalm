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

/**
 * Resolve the host UI's listen port.
 *
 * Precedence, deliberately matching every other resolver in the codebase: an
 * explicit argument (a `--port` flag) wins, then live process env, then the
 * home's persisted stack.env, then the default. Live-env-over-persisted is the
 * important half: Electron's child env spread had it INVERTED, so a value an
 * operator exported before launching the desktop app was silently overridden by
 * the file, while the identical launch through `openpalm` honored it.
 */
export function resolveHostUiPort(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
  persistedEnv: Record<string, string | undefined> = {},
): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  const merged = { ...persistedEnv, ...env };
  return Number(merged.OP_HOST_UI_PORT) || DEFAULT_HOST_UI_PORT;
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
}): UiListenEnv {
  if (!opts.admin && opts.allowRemote) {
    return {
      HOST: "0.0.0.0",
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
