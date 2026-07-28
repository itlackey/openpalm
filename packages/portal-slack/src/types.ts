import type {
  PermissionConfig as BasePermissionConfig,
  UserInfo as BaseUserInfo,
} from "@openpalm/portal-sdk";

export type { PermissionResult } from "@openpalm/portal-sdk";

export type PermissionConfig = BasePermissionConfig & {
  allowedChannels: Set<string>;
};

export type UserInfo = BaseUserInfo & {
  teamId: string;
  channelId: string;
};
