export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

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

export const MessageFlags = {
  EPHEMERAL: 1 << 6,
} as const;

export type DiscordUser = {
  id?: string;
  username?: string;
  global_name?: string;
};

export type DiscordMember = {
  user?: DiscordUser;
  roles?: string[];
};

export type DiscordCommandOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
  focused?: boolean;
};

export type DiscordInteraction = {
  id: string;
  type: number;
  application_id?: string;
  token?: string;
  data?: {
    id?: string;
    name?: string;
    type?: number;
    options?: DiscordCommandOption[];
    custom_id?: string;
  };
  guild_id?: string;
  channel_id?: string;
  member?: DiscordMember;
  user?: DiscordUser;
};

export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
};

export type InteractionResponse = {
  type: number;
  data?: {
    content?: string;
    embeds?: DiscordEmbed[];
    flags?: number;
    choices?: Array<{ name: string; value: string }>;
  };
};

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
