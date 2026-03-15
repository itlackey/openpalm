import { createLogger } from "@openpalm/channels-sdk";
import type { PermissionConfig, PermissionResult, UserInfo } from "./types.ts";

const log = createLogger("channel-slack");

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
  const { userId, channelId, username } = user;

  if (userId && config.blockedUsers.has(userId)) {
    log.warn("permission_denied", { userId, username, reason: "blocked_user" });
    return { allowed: false, reason: "user_blocked" };
  }

  if (config.allowedUsers.size > 0) {
    if (!userId || !config.allowedUsers.has(userId)) {
      return { allowed: false, reason: "user_not_allowed" };
    }
  }

  if (config.allowedChannels.size > 0) {
    if (!channelId || !config.allowedChannels.has(channelId)) {
      return { allowed: false, reason: "channel_not_allowed" };
    }
  }

  return { allowed: true };
}
