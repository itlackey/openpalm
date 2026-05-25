export type PermissionConfig = {
  allowedChannels: Set<string>;
  allowedUsers: Set<string>;
  blockedUsers: Set<string>;
};

export type { PermissionResult } from "@openpalm/channels-sdk";

export type UserInfo = {
  userId: string;
  teamId: string;
  channelId: string;
  username?: string;
};
