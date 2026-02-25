/**
 * Permission checking for Discord interactions.
 *
 * Supports guild, role, and user-level allowlists and blocklists.
 * When an allowlist is empty, that dimension is unrestricted.
 * Blocklists always take priority over allowlists.
 */

import type { DiscordInteraction, PermissionConfig, PermissionResult } from "./types.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("channel-discord");

/** Parse a comma-separated env var into a Set of trimmed, non-empty strings. */
export function parseIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Build a PermissionConfig from environment variables. */
export function loadPermissionConfig(env: Record<string, string | undefined> = Bun.env): PermissionConfig {
  const config: PermissionConfig = {
    allowedGuilds: parseIdList(env.DISCORD_ALLOWED_GUILDS),
    allowedRoles: parseIdList(env.DISCORD_ALLOWED_ROLES),
    allowedUsers: parseIdList(env.DISCORD_ALLOWED_USERS),
    blockedUsers: parseIdList(env.DISCORD_BLOCKED_USERS),
  };

  log.info("permissions_loaded", {
    allowedGuilds: config.allowedGuilds.size || "unrestricted",
    allowedRoles: config.allowedRoles.size || "unrestricted",
    allowedUsers: config.allowedUsers.size || "unrestricted",
    blockedUsers: config.blockedUsers.size || "none",
  });

  return config;
}

/**
 * Extract the user ID, guild ID, and role IDs from a Discord interaction.
 * Works for both guild interactions (member.user) and DM interactions (user).
 */
export function extractIdentifiers(interaction: DiscordInteraction): {
  userId: string;
  guildId: string;
  roles: string[];
  username: string;
} {
  const user = interaction.member?.user ?? interaction.user;
  return {
    userId: user?.id ?? "",
    guildId: interaction.guild_id ?? "",
    roles: interaction.member?.roles ?? [],
    username: user?.username ?? user?.global_name ?? "unknown",
  };
}

/**
 * Check whether an interaction is permitted based on the loaded config.
 *
 * Evaluation order:
 * 1. Blocked users → deny immediately
 * 2. Allowed users (if non-empty) → must be in the set
 * 3. Allowed guilds (if non-empty) → must be in the set
 * 4. Allowed roles (if non-empty) → must have at least one matching role
 * 5. All checks passed → allow
 */
export function checkPermissions(
  config: PermissionConfig,
  interaction: DiscordInteraction,
): PermissionResult {
  const { userId, guildId, roles, username } = extractIdentifiers(interaction);

  // 1. Blocklist always wins
  if (userId && config.blockedUsers.has(userId)) {
    log.warn("permission_denied", { userId, username, reason: "blocked_user" });
    return { allowed: false, reason: "user_blocked" };
  }

  // 2. User allowlist
  if (config.allowedUsers.size > 0) {
    if (!userId || !config.allowedUsers.has(userId)) {
      log.debug("permission_denied", { userId, username, reason: "user_not_in_allowlist" });
      return { allowed: false, reason: "user_not_allowed" };
    }
  }

  // 3. Guild allowlist
  if (config.allowedGuilds.size > 0) {
    if (!guildId || !config.allowedGuilds.has(guildId)) {
      log.debug("permission_denied", { userId, guildId, reason: "guild_not_in_allowlist" });
      return { allowed: false, reason: "guild_not_allowed" };
    }
  }

  // 4. Role allowlist — user must have at least one matching role
  if (config.allowedRoles.size > 0) {
    const hasMatchingRole = roles.some((r) => config.allowedRoles.has(r));
    if (!hasMatchingRole) {
      log.debug("permission_denied", { userId, roles, reason: "no_matching_role" });
      return { allowed: false, reason: "role_not_allowed" };
    }
  }

  return { allowed: true };
}
