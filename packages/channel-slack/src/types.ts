export type PermissionConfig = {
  allowedChannels: Set<string>;
  allowedUsers: Set<string>;
  blockedUsers: Set<string>;
};

export type PermissionResult = {
  allowed: boolean;
  reason?: string;
};

export type UserInfo = {
  userId: string;
  teamId: string;
  channelId: string;
  username?: string;
};
