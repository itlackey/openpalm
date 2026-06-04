/**
 * API channel non-interactive permission policy (design §4.5) — Stage 6.
 *
 * The OpenAI/Anthropic API channel is NON-interactive: no human is present to
 * click Approve/Deny on a `permission.asked`. So the adapter applies a declared
 * policy automatically. Per §4.5:
 *
 *   - DEFAULT: reject — deny any tool that needs approval. The assistant then
 *     continues or reports it could not act. This is *safer than today*, where
 *     static config silently allows/denies with no audit trail.
 *   - OPT-IN: `auto: once` with an EXPLICIT tool allowlist for trusted
 *     programmatic clients — a deliberate, configured relaxation, never a
 *     default. A request whose tool is not on the allowlist still rejects.
 *
 * Either way the decision is a normal signed, ownership-checked
 * `POST /permission/{requestID}/reply` issued through the guardian (the channel
 * never bypasses the guardian — it stays the sole mediator). This module only
 * DECIDES the reply value; OcClient.replyPermission performs the signed call.
 *
 * Pure + deterministic: no I/O beyond reading the supplied env record at load
 * time. `decidePermission` is a pure function of (policy, ask), trivially
 * unit-testable — mirroring the content-screen/oc-events placement style.
 */

import { createLogger, parseIdList, type PermissionAsk } from "@openpalm/channels-sdk";

const log = createLogger("channel-api");

/** The reply the guardian relays to OpenCode. `"reject"` denies the tool. */
export type PermissionReply = "once" | "reject";

export interface PermissionPolicy {
  /**
   * `reject` (default) denies every permission request. `auto` approves
   * (`reply:"once"`) ONLY requests whose tool/permission name is in `allowlist`;
   * anything else still rejects.
   */
  mode: "reject" | "auto";
  /** Tool/permission names auto-approved when `mode === "auto"`. */
  allowlist: Set<string>;
}

/**
 * Load the policy from env. Default is the fail-closed `reject` mode.
 *
 *   OP_API_PERMISSION_MODE=auto                 — opt into auto-approval
 *   OP_API_PERMISSION_ALLOWLIST=bash,edit       — tools auto-approved in `auto`
 *
 * `auto` with an EMPTY allowlist is a misconfiguration that would approve
 * nothing — it is logged and behaves exactly like `reject` (every request
 * falls through to deny), so it is never an accidental open door.
 */
export function loadPermissionPolicy(env: Record<string, string | undefined> = Bun.env): PermissionPolicy {
  const rawMode = env.OP_API_PERMISSION_MODE?.trim().toLowerCase();
  const mode: PermissionPolicy["mode"] = rawMode === "auto" ? "auto" : "reject";
  const allowlist = parseIdList(env.OP_API_PERMISSION_ALLOWLIST);

  log.info("permission_policy_loaded", {
    mode,
    allowlist: mode === "auto" ? (allowlist.size ? [...allowlist].join(",") : "empty(=reject-all)") : "n/a",
  });

  return { mode, allowlist };
}

/**
 * Decide the reply for a `permission.asked` under the policy. PURE.
 *
 * `reject` → always deny. `auto` → approve (`once`) only when the request's
 * permission/tool name is in the allowlist, else deny. Nothing is ever approved
 * by default; the allowlist must be configured explicitly.
 */
export function decidePermission(policy: PermissionPolicy, ask: PermissionAsk): PermissionReply {
  if (policy.mode === "auto" && policy.allowlist.has(ask.permission)) {
    return "once";
  }
  return "reject";
}
