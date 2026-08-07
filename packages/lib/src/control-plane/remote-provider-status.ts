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
 * back, and "could not observe" is itself an observation.
 */
import type { ControlPlaneState } from "./types.js";
import { composeExec } from "./docker.js";
import { buildComposeOptions } from "./compose-args.js";
import { readStackEnv } from "./secrets.js";
import { readRemoteAccessConfig } from "./remote-access.js";
import {
  remoteAddonEnabled,
  selectedRemoteProviderId,
  type RemoteAccessStatus,
} from "./remote-providers.js";

/**
 * The subset of `tailscale status --json` this module reads. AuthURL is
 * populated while the node needs an interactive sign-in; DNSName is the
 * node's FQDN with a trailing dot, populated once registered.
 */
type TailscaleStatusJson = {
  BackendState?: string;
  AuthURL?: string;
  Self?: { DNSName?: string };
};

export async function fetchRemoteProviderStatus(state: ControlPlaneState): Promise<RemoteAccessStatus> {
  const env = readStackEnv(state.homeDir);

  if (!remoteAddonEnabled(env)) {
    return { state: "off", message: "Remote access is turned off." };
  }

  const providerId = selectedRemoteProviderId(env);
  switch (providerId) {
    case "tailscale":
      return fetchTailscaleStatus(state, env);
    default:
      return {
        state: "error",
        message: `Remote provider "${providerId}" has no status implementation.`,
      };
  }
}

async function fetchTailscaleStatus(
  state: ControlPlaneState,
  env: Record<string, string | undefined>,
): Promise<RemoteAccessStatus> {
  // --socket is load-bearing, not a nicety: the tunnel container runs
  // rootless, so containerboot relocates the LocalAPI socket to
  // /tmp/tailscaled.sock (TS_SOCKET in services.compose.yml, pinned by
  // remote-compose.test.ts). A bare `tailscale status` looks in /var/run and
  // reports the tunnel as down even when it is healthy — the compose file's
  // "CONSEQUENCE FOR CALLERS" comment documents exactly this call shape.
  const result = await composeExec(
    "tunnel",
    ["tailscale", "--socket=/tmp/tailscaled.sock", "status", "--json"],
    { ...buildComposeOptions(state), timeoutMs: 10_000 },
  );

  if (!result.ok) {
    // The exec fails for a container that is still creating, crash-looping,
    // or already gone — all "not answering", none distinguishable here
    // without a second Docker round-trip. Say what is known and where the
    // detail lives, rather than guessing a cause.
    return {
      state: "starting",
      message:
        "The tunnel container isn't answering yet. If this persists, check its logs "
        + "(openpalm logs tunnel).",
    };
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
    // Advertise LAST: the URL appears only in `up`, and only from the
    // node's own reported FQDN — never interpolated from config
    // (describeRemoteExposure's rule; the tailnet suffix is assigned at
    // registration and unknowable before it).
    const config = readRemoteAccessConfig(env);
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
    return {
      state: "up",
      message: `The tunnel is up. ${reach}`,
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
