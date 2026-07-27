/**
 * Shared permission engine for OpenPalm chat portals.
 *
 * Every portal enforces the same shape of access control — a blocklist that
 * always wins, followed by a series of allow-scopes (users, channels, guilds,
 * roles, …) where a non-empty scope must match at least one of the caller's
 * actual values. Portals differ only in WHICH scopes they have and the env
 * vars that populate them; that mapping stays local to each portal. This
 * module owns the platform-agnostic evaluation so it lives in exactly one
 * place.
 */
import { createLogger } from './runtime.ts';

const log = createLogger('portal-permissions');

/** Outcome of a permission check. Shared verbatim by every portal. */
export type PermissionResult = {
  allowed: boolean;
  reason?: string;
};

/** Fields the engine needs from a caller; portals extend this per platform. */
export type UserInfo = {
  userId: string;
  username?: string;
};

/** Access-control fields common to every portal's config. */
export type PermissionConfig = {
  allowedUsers: Set<string>;
  blockedUsers: Set<string>;
};

/**
 * One allow-scope. When `allowedSet` is non-empty, at least one truthy value
 * in `actualValues` must be a member or the check fails with `reason`. An
 * empty `allowedSet` means "unrestricted" and is skipped.
 */
export type PermissionRule = {
  allowedSet: Set<string>;
  actualValues: Array<string | undefined>;
  reason: string;
};

/** The full rule set a portal hands to the engine for one caller. */
export type PermissionRuleSet = {
  /** Users denied outright, before any allow-scope is consulted. */
  blocked: Set<string>;
  /** Ordered allow-scopes; the first that fails determines the reason. */
  rules: PermissionRule[];
};

/**
 * Evaluate a caller against a rule set. Blocklist wins first; then, unless
 * every allow-scope is empty (see below), each non-empty scope must match —
 * the first failing scope's reason is returned.
 *
 * (G3) Default-deny: if EVERY rule's `allowedSet` is empty, there is no
 * allowlist configured at all, and the caller is denied with
 * `no_allowlist_configured` rather than silently let through. This is
 * evaluated across the whole rule set (not by naming individual scopes) so a
 * portal with only one scope configured — e.g. a Slack channels-only
 * allowlist — is never misclassified as "nothing configured".
 *
 * (G3) Explicit allow-all opt-in: a scope whose `allowedSet` contains the
 * sentinel `"*"` is treated as unrestricted for that scope (skipped), the
 * same as an empty scope would have been under the old behaviour — but now
 * it must be asked for explicitly rather than defaulted into.
 */
export function checkPermissions(ruleSet: PermissionRuleSet, user: UserInfo): PermissionResult {
  const { userId, username } = user;

  if (userId && ruleSet.blocked.has(userId)) {
    log.warn('permission_denied', { userId, username, reason: 'blocked_user' });
    return { allowed: false, reason: 'user_blocked' };
  }

  if (ruleSet.rules.every((rule) => rule.allowedSet.size === 0)) {
    log.warn('permission_denied', { userId, username, reason: 'no_allowlist_configured' });
    return { allowed: false, reason: 'no_allowlist_configured' };
  }

  for (const { allowedSet, actualValues, reason } of ruleSet.rules) {
    if (allowedSet.size === 0 || allowedSet.has('*')) continue;
    const matched = actualValues.some((v) => Boolean(v) && allowedSet.has(v as string));
    if (!matched) return { allowed: false, reason };
  }

  return { allowed: true };
}
