/**
 * Node-side apply dispatch for the `remote` addon's providers: resolve which
 * provider `OP_REMOTE_PROFILE` selects, run that provider's applyConfig.
 *
 * This is the lookup that replaced the `if (name === 'remote')
 * applyRemoteAccess(...)` special cases in addons.ts and the credentials
 * route (roadmap: remote-access-providers.md §3): those call sites now know
 * only that the remote addon has a provider apply, not which provider or
 * what its artifacts are. A later provider (pangolin-*) is a new arm here
 * plus its registry entry — no caller changes.
 *
 * Kept separate from remote-provider-status.ts deliberately: addons.ts
 * imports this module, and the status fetcher needs compose-args, whose
 * import chain (compose-args → lifecycle → addons) would close a cycle
 * through here. Apply needs nothing from that chain.
 *
 * Never throws — the applyRemoteAccess convention carries over: failures are
 * reported in the result so callers surface a message instead of an
 * unhandled rejection.
 */
import { applyRemoteAccess } from "./remote-apply.js";
import { patchSecretsEnvFile, readStackEnv } from "./secrets.js";
import { remoteAddonEnabled, selectedRemoteProviderId } from "./remote-providers.js";

/**
 * What every provider's apply reports back to the shared enable/save paths:
 * the services whose containers must be recreated for the apply to take
 * effect, an operator-facing warning when the result cannot work as
 * configured and only the operator can finish it, and an error when the
 * apply itself failed. Structurally a subset of `RemoteAccessApplyResult` —
 * the Tailscale apply's richer fields stay private to its own module.
 */
export type RemoteProviderApplyResult = {
  services: string[];
  warning?: string;
  error?: string;
};

/**
 * Provider-INDEPENDENT half of the apply: behind any remote sidecar, every
 * request reaches the UI container from one address (the sidecar's), which
 * turns the per-client login throttle into a global lockout — five failed
 * attempts by anyone lock out the owner (login-throttle.ts documents the
 * hazard; the original roadmap called it the "one genuine gap"). Enabled →
 * adapter-node keys clients by X-Forwarded-For (depth 1: exactly one proxy
 * this stack controls). Disabled → cleared, because a LAN client hitting
 * the container port DIRECTLY could forge the header to rotate throttle
 * keys; the header is only trustworthy while a stack-controlled proxy sets
 * it. (While remote AND a LAN publish are BOTH active, that forgery window
 * exists for LAN clients — accepted and documented in core.compose.yml;
 * the alternative, a global lockout for every remote user, is worse.)
 *
 * The env flip is consumed at container create, so the assistant joins the
 * recreate scope when it changes — the one case a remote toggle recreates
 * the assistant, and only on the enable/disable edge, never on a config
 * save.
 */
function reconcileUiForwardedAddressEnv(homeDir: string): { changed: boolean } {
  const env = readStackEnv(homeDir);
  const enabled = remoteAddonEnabled(env);
  const desired = enabled
    ? { OP_UI_ADDRESS_HEADER: "x-forwarded-for", OP_UI_XFF_DEPTH: "1" }
    : { OP_UI_ADDRESS_HEADER: "", OP_UI_XFF_DEPTH: "" };
  const changed =
    (env.OP_UI_ADDRESS_HEADER ?? "") !== desired.OP_UI_ADDRESS_HEADER
    || (env.OP_UI_XFF_DEPTH ?? "") !== desired.OP_UI_XFF_DEPTH;
  if (changed) patchSecretsEnvFile(homeDir, desired);
  return { changed };
}

export function applyRemoteProviderConfig(homeDir: string): RemoteProviderApplyResult {
  const providerId = selectedRemoteProviderId(readStackEnv(homeDir));

  const provider = ((): RemoteProviderApplyResult => {
    switch (providerId) {
      case "tailscale": {
        const applied = applyRemoteAccess(homeDir);
        return {
          services: applied.services,
          ...(applied.warning ? { warning: applied.warning } : {}),
          ...(applied.error ? { error: applied.error } : {}),
        };
      }
      default:
        // selectedRemoteProviderId falls back to the default provider for
        // anything unrecognized, so this arm is unreachable until a registry
        // entry ships without its apply — which is exactly the mistake worth
        // reporting loudly instead of applying nothing silently.
        return {
          services: [],
          error: `Remote provider "${providerId}" has no apply implementation.`,
        };
    }
  })();

  // Runs even when the provider apply FAILED: the forwarded-header env must
  // track the remote-ENABLED intent, not the apply's success. Skipping it on
  // a failed disable left OP_UI_ADDRESS_HEADER=x-forwarded-for keying the
  // login throttle with no trusted proxy in front — a LAN client could forge
  // the header to rotate throttle keys at will.
  try {
    const forwarded = reconcileUiForwardedAddressEnv(homeDir);
    const services = forwarded.changed
      ? [...new Set([...provider.services, "assistant"])]
      : provider.services;
    return { ...provider, services };
  } catch (err) {
    return {
      ...provider,
      // A provider error outranks the reconcile's own — it is the failure the
      // caller acts on, and callers already treat `error` as singular.
      error: provider.error ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}
