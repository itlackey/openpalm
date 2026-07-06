import { checkPermissions as evaluatePermissions, createLogger, parseIdList } from '@openpalm/portal-sdk';
import type { PermissionResult } from './types.ts';
import type { PermissionConfig, UserInfo } from "./types.ts";

const log = createLogger("portal-discord");

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
  return evaluatePermissions(
    {
      blocked: config.blockedUsers,
      rules: [
        { allowedSet: config.allowedUsers, actualValues: [user.userId], reason: "user_not_allowed" },
        { allowedSet: config.allowedGuilds, actualValues: [user.guildId], reason: "guild_not_allowed" },
        { allowedSet: config.allowedRoles, actualValues: user.roles, reason: "role_not_allowed" },
      ],
    },
    user,
  );
}
