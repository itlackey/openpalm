import { createLogger } from "@openpalm/channels-sdk";
import type { PermissionConfig, PermissionResult, UserInfo } from "./types.ts";

const log = createLogger("channel-discord");

export function parseIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

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

export function checkPermissions(config: PermissionConfig, user: UserInfo): PermissionResult {
  const { userId, guildId, roles, username } = user;

  if (userId && config.blockedUsers.has(userId)) {
    log.warn("permission_denied", { userId, username, reason: "blocked_user" });
    return { allowed: false, reason: "user_blocked" };
  }

  if (config.allowedUsers.size > 0) {
    if (!userId || !config.allowedUsers.has(userId)) {
      return { allowed: false, reason: "user_not_allowed" };
    }
  }

  if (config.allowedGuilds.size > 0) {
    if (!guildId || !config.allowedGuilds.has(guildId)) {
      return { allowed: false, reason: "guild_not_allowed" };
    }
  }

  if (config.allowedRoles.size > 0) {
    const hasMatchingRole = roles.some((r) => config.allowedRoles.has(r));
    if (!hasMatchingRole) {
      return { allowed: false, reason: "role_not_allowed" };
    }
  }

  return { allowed: true };
}
