import { checkPermissions as evaluatePermissions, createLogger, parseIdList } from '@openpalm/portal-sdk';
import type { PermissionResult } from './types.ts';
import type { PermissionConfig, UserInfo } from "./types.ts";

const log = createLogger("portal-slack");

export function loadPermissionConfig(env: Record<string, string | undefined> = Bun.env): PermissionConfig {
  const config: PermissionConfig = {
    allowedChannels: parseIdList(env.SLACK_ALLOWED_CHANNELS),
    allowedUsers: parseIdList(env.SLACK_ALLOWED_USERS),
    blockedUsers: parseIdList(env.SLACK_BLOCKED_USERS),
  };

  log.info("permissions_loaded", {
    allowedChannels: config.allowedChannels.size || "unrestricted",
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
        { allowedSet: config.allowedChannels, actualValues: [user.channelId], reason: "channel_not_allowed" },
      ],
    },
    user,
  );
}
