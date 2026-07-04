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
 * Evaluate a caller against a rule set. Blocklist wins first, then each
 * non-empty allow-scope must match; the first failing scope's reason is
 * returned. Behaviour is identical to the per-portal checks it replaces.
 */
export function checkPermissions(ruleSet: PermissionRuleSet, user: UserInfo): PermissionResult {
  const { userId, username } = user;

  if (userId && ruleSet.blocked.has(userId)) {
    log.warn('permission_denied', { userId, username, reason: 'blocked_user' });
    return { allowed: false, reason: 'user_blocked' };
  }

  for (const { allowedSet, actualValues, reason } of ruleSet.rules) {
    if (allowedSet.size === 0) continue;
    const matched = actualValues.some((v) => Boolean(v) && allowedSet.has(v as string));
    if (!matched) return { allowed: false, reason };
  }

  return { allowed: true };
}
