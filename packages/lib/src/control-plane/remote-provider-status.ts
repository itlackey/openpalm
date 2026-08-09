/**
 * Node-side status read-back for the `remote` addon's providers: the
 * observed state the UI's provider card renders, mapped into the normalized
 * `RemoteAccessStatus` vocabulary (remote-providers.ts).
 *
 * Separate from remote-provider-apply.ts because this module needs
 * compose-args (whose import chain reaches addons.ts), and addons.ts imports
 * the apply dispatcher — see that module's docblock. Nothing here is called
 * from the enable/save paths; the only consumer is the status route.
 *
 * Every path returns a status, never throws: the card renders whatever came
 * back, and "could not observe" is itself an observation. Docker access is
 * injected (`RemoteProviderStatusDeps`, the `fetchAccessStatusActual`
 * convention) so every state transition below is unit-testable without a
 * daemon.
 */
import type { ControlPlaneState } from "./types.js";
import { composeExec, composePs, isComposePsRowHealthy, parseComposePsRows } from "./docker.js";
import { buildComposeOptions } from "./compose-args.js";
import { readStackEnv } from "./secrets.js";
import { readRemoteAccessConfig, type RemoteAccessConfig } from "./remote-access.js";
import {
  remoteAddonEnabled,
  selectedRemoteProviderId,
  type RemoteAccessStatus,
} from "./remote-providers.js";

export type RemoteProviderStatusDeps = {
  composeExec: typeof composeExec;
  composePs: typeof composePs;
  /** Injected clock so key-expiry states are testable. */
  now: () => number;
};

export const defaultRemoteProviderStatusDeps: RemoteProviderStatusDeps = {
  composeExec,
  composePs,
  now: () => Date.now(),
};

/**
 * Surface an approaching node-key expiry this many days out. Tailscale node
 * keys default to 180-day expiry, and an expired key drops the node off the
 * tailnet with no in-app signal — the original roadmap's risk 6. Two weeks
 * is early enough to act on and late enough not to nag for a quarter.
 */
const KEY_EXPIRY_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The subset of `tailscale status --json` this module reads. AuthURL is
 * populated while the node needs an interactive sign-in; DNSName is the
 * node's FQDN with a trailing dot, populated once registered; KeyExpiry is
 * the node key's RFC3339 expiry timestamp, absent for tagged nodes (which
 * do not expire).
 */
type TailscaleStatusJson = {
  BackendState?: string;
  AuthURL?: string;
  Self?: { DNSName?: string; KeyExpiry?: string };
};

export async function fetchRemoteProviderStatus(
  state: ControlPlaneState,
  deps: Partial<RemoteProviderStatusDeps> = {},
): Promise<RemoteAccessStatus> {
  const resolved = { ...defaultRemoteProviderStatusDeps, ...deps };
  const env = readStackEnv(state.homeDir);

  if (!remoteAddonEnabled(env)) {
    return { state: "off", message: "Remote access is turned off." };
  }

  const providerId = selectedRemoteProviderId(env);
  switch (providerId) {
    case "tailscale":
      return fetchTailscaleStatus(state, env, resolved);
    default:
      return {
        state: "error",
        message: `Remote provider "${providerId}" has no status implementation.`,
      };
  }
}

/**
 * When `tailscale status` cannot be exec'd at all, one `compose ps` round
 * trip distinguishes the three honest answers a bare exec failure collapses:
 * the container was never started, it is stopped/crash-looping, or it is up
 * but containerboot has not brought the LocalAPI socket up yet. Without
 * this, a crash loop reads as "starting" forever — the observation the
 * vocabulary calls `error` reported as patience.
 */
async function tailscaleStatusFromContainerState(
  state: ControlPlaneState,
  deps: RemoteProviderStatusDeps,
): Promise<RemoteAccessStatus> {
  const options = buildComposeOptions(state);
  const result = await deps.composePs({ files: options.files, envFiles: options.envFiles });
  if (!result.ok) {
    return {
      state: "starting",
      message:
        "The tunnel container isn't answering, and Docker couldn't be asked why. "
        + "If this persists, check the stack (openpalm status).",
    };
  }

  const row = parseComposePsRows(result.stdout).find((r) => r.service === "tunnel");
  if (!row) {
    return {
      state: "starting",
      message:
        "The tunnel container hasn't been started yet. Run openpalm start if the "
        + "stack isn't already coming up.",
    };
  }
  if (row.state.trim().toLowerCase() !== "running") {
    return {
      state: "error",
      message:
        "The tunnel container is stopped or crash-looping. Check its logs "
        + "(openpalm logs tunnel).",
    };
  }
  return {
    state: isComposePsRowHealthy(row) ? "degraded" : "starting",
    // Healthy container + dead LocalAPI is a contradiction worth naming;
    // a still-unhealthy container is just containerboot booting.
    message: isComposePsRowHealthy(row)
      ? "The tunnel container is running but its status socket isn't answering. "
        + "Check its logs (openpalm logs tunnel)."
      : "The tunnel container is starting up.",
  };
}

async function fetchTailscaleStatus(
  state: ControlPlaneState,
  env: Record<string, string | undefined>,
  deps: RemoteProviderStatusDeps,
): Promise<RemoteAccessStatus> {
  // --socket is load-bearing, not a nicety: the tunnel container runs
  // rootless, so containerboot relocates the LocalAPI socket to
  // /tmp/tailscaled.sock (TS_SOCKET in services.compose.yml, pinned by
  // remote-compose.test.ts). A bare `tailscale status` looks in /var/run and
  // reports the tunnel as down even when it is healthy — the compose file's
  // "CONSEQUENCE FOR CALLERS" comment documents exactly this call shape.
  const result = await deps.composeExec(
    "tunnel",
    ["tailscale", "--socket=/tmp/tailscaled.sock", "status", "--json"],
    { ...buildComposeOptions(state), timeoutMs: 10_000 },
  );

  if (!result.ok) {
    return tailscaleStatusFromContainerState(state, deps);
  }

  let status: TailscaleStatusJson;
  try {
    status = JSON.parse(result.stdout) as TailscaleStatusJson;
  } catch {
    return {
      state: "error",
      message: "The tunnel answered with something unreadable instead of its status.",
    };
  }

  if (status.AuthURL) {
    return {
      state: "awaiting-authentication",
      message:
        "The tunnel is ready to join your Tailscale account. Sign in once and it "
        + "finishes on its own.",
      action: { label: "Connect your account", url: status.AuthURL },
    };
  }

  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
  if (status.BackendState === "Running" && dnsName) {
    // Node-key expiry (roadmap remote-access-from-anywhere.md risk 6): an
    // expired key drops the node off the tailnet silently, and the only
    // recovery is a fresh sign-in. Surface it while there is still time to
    // act, and name it plainly once it has happened. KeyExpiry is absent
    // for tagged nodes, whose keys do not expire — no warning then.
    const expiryMs = status.Self?.KeyExpiry ? Date.parse(status.Self.KeyExpiry) : Number.NaN;
    if (Number.isFinite(expiryMs) && expiryMs <= deps.now()) {
      return {
        state: "degraded",
        message:
          "The tunnel's Tailscale key has expired, so devices can no longer reach "
          + "it. Sign in again to renew it.",
      };
    }

    // Advertise LAST: the URL appears only in `up`, and only from the
    // node's own reported FQDN — never interpolated from config
    // (describeRemoteExposure's rule; the tailnet suffix is assigned at
    // registration and unknowable before it).
    //
    // Caught, not propagated: readRemoteAccessConfig throws on an invalid
    // OP_REMOTE_TARGET, and this module's contract is that every path
    // returns a status. An unreadable config is itself an observation.
    let config: RemoteAccessConfig;
    try {
      config = readRemoteAccessConfig(env);
    } catch (err) {
      return {
        state: "error",
        message: `The tunnel is connected, but its stored config could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const copyables: NonNullable<RemoteAccessStatus["copyables"]> = [];
    if (config.target === "assistant" || config.target === "both") {
      copyables.push({ label: "Assistant address", value: `https://${dnsName}`, qr: true });
    }
    if (config.target === "guardian" || config.target === "both") {
      copyables.push({ label: "Guardian address", value: `https://${dnsName}:8443` });
    }
    const reach = config.public
      ? "Anyone with the address can reach the sign-in page."
      : "Only devices signed in to your Tailscale account can reach it.";
    const daysLeft = Number.isFinite(expiryMs)
      ? Math.floor((expiryMs - deps.now()) / DAY_MS)
      : Number.POSITIVE_INFINITY;
    const expiryNote =
      daysLeft <= KEY_EXPIRY_WARN_DAYS
        ? ` Its Tailscale key expires in ${Math.max(daysLeft, 0)} day${daysLeft === 1 ? "" : "s"} — sign in again before then to keep it reachable.`
        : "";
    return {
      state: "up",
      message: `The tunnel is up. ${reach}${expiryNote}`,
      copyables,
    };
  }

  if (status.BackendState === "Starting" || status.BackendState === "NoState") {
    return { state: "starting", message: "The tunnel is connecting to Tailscale." };
  }

  return {
    state: "degraded",
    message: `The tunnel is running but not connected (Tailscale reports "${
      status.BackendState ?? "unknown"
    }").`,
  };
}
