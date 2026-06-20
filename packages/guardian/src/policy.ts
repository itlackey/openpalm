/**
 * Authorization policy seam.
 *
 * Public OpenPalm authorizes by ownership (a principal may only touch sessions
 * it created — see `ownership.ts`) and rate limits. Richer authorization
 * (per-tenant data scope, role-based access, multi-agent routing) is a
 * downstream concern. This module defines the *port* those distributions
 * implement; the public guardian ships only the permissive default and does not
 * consult it on the built-in routes, so wiring a provider changes nothing here.
 *
 * A downstream auth strategy or transport reads {@link getPolicyProvider} to
 * make decisions, and the composition root installs one via
 * {@link setPolicyProvider}.
 */

/** An authorization request: a principal attempting an action on a resource. */
export interface PolicyRequest {
  /** The authenticated principal id (e.g. portal/direct id, or a user subject). */
  principalId: string;
  /** Optional principal kind / role hint. */
  kind?: string;
  /** The action being attempted (e.g. `"oc:session.read"`, `"a2a:invoke"`). */
  action: string;
  /** The resource the action targets (e.g. a session id, agent name, tenant). */
  resource?: string;
  /** Arbitrary additional attributes for attribute-based decisions. */
  attributes?: Record<string, unknown>;
}

/** The outcome of a policy decision. */
export interface PolicyDecision {
  allow: boolean;
  /** Optional human-readable reason (surfaced in audit logs / 403 bodies). */
  reason?: string;
}

/** Pluggable authorization policy. */
export interface PolicyProvider {
  authorize(request: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

/** The public default: allow everything (ownership + rate limits still apply). */
export const allowAllPolicy: PolicyProvider = {
  authorize: () => ({ allow: true }),
};

let activeProvider: PolicyProvider = allowAllPolicy;

/** Install the active authorization policy. */
export function setPolicyProvider(provider: PolicyProvider): void {
  activeProvider = provider;
}

/** The active authorization policy (defaults to {@link allowAllPolicy}). */
export function getPolicyProvider(): PolicyProvider {
  return activeProvider;
}

/** Reset to the permissive default (test/composition helper). */
export function resetPolicyProvider(): void {
  activeProvider = allowAllPolicy;
}
