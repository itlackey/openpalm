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

export type PermissionConfig = {
  allowedGuilds: Set<string>;
  allowedRoles: Set<string>;
  allowedUsers: Set<string>;
  blockedUsers: Set<string>;
};

export type PermissionResult = {
  allowed: boolean;
  reason?: string;
};

/** Simple user info extracted from discord.js Message or Interaction objects. */
export type UserInfo = {
  userId: string;
  guildId: string;
  roles: string[];
  username: string;
};
