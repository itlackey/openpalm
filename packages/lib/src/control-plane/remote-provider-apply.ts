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
import { readStackEnv } from "./secrets.js";
import { selectedRemoteProviderId } from "./remote-providers.js";

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

export function applyRemoteProviderConfig(homeDir: string): RemoteProviderApplyResult {
  const providerId = selectedRemoteProviderId(readStackEnv(homeDir));

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
}
