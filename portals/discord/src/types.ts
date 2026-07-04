export const CommandOptionType = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  MENTIONABLE: 9,
  NUMBER: 10,
  ATTACHMENT: 11,
} as const;

export type CustomCommandOption = {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: Array<{ name: string; value: string }>;
};

export type CustomCommandDef = {
  name: string;
  description: string;
  options?: CustomCommandOption[];
  promptTemplate?: string;
  ephemeral?: boolean;
};

import type {
  PermissionConfig as BasePermissionConfig,
  UserInfo as BaseUserInfo,
} from "@openpalm/portal-sdk";

export type { PermissionResult } from "@openpalm/portal-sdk";

export type PermissionConfig = BasePermissionConfig & {
  allowedGuilds: Set<string>;
  allowedRoles: Set<string>;
};

/** Simple user info extracted from discord.js Message or Interaction objects. */
export type UserInfo = BaseUserInfo & {
  guildId: string;
  roles: string[];
  username: string;
};
