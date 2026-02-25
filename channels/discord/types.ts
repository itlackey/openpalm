/**
 * Discord API type definitions for the interactions endpoint model.
 *
 * These are minimal, purpose-built types covering only what the OpenPalm
 * Discord channel needs. They follow the Discord API v10 specification.
 */

/* ── Interaction types ─────────────────────────────────────────────── */

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

/* ── Command option types ──────────────────────────────────────────── */

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

/* ── Component types ───────────────────────────────────────────────── */

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
} as const;

export const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
} as const;

/* ── Message flags ─────────────────────────────────────────────────── */

export const MessageFlags = {
  EPHEMERAL: 1 << 6,
} as const;

/* ── Structural types ──────────────────────────────────────────────── */

export type DiscordUser = {
  id?: string;
  username?: string;
  discriminator?: string;
  global_name?: string;
  avatar?: string;
  bot?: boolean;
};

export type DiscordMember = {
  user?: DiscordUser;
  roles?: string[];
  permissions?: string;
  nick?: string;
  joined_at?: string;
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
    component_type?: number;
    values?: string[];
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
  thumbnail?: { url: string };
  author?: { name: string; icon_url?: string; url?: string };
};

export type DiscordComponent = {
  type: number;
  components?: DiscordComponent[];
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
  emoji?: { name?: string; id?: string };
};

export type InteractionResponse = {
  type: number;
  data?: {
    content?: string;
    embeds?: DiscordEmbed[];
    components?: DiscordComponent[];
    flags?: number;
  };
};

/* ── Custom command config ─────────────────────────────────────────── */

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
  /** Template for the prompt sent to the assistant. Use {{optionName}} placeholders. */
  promptTemplate?: string;
  /** If true, response is only visible to the invoking user. */
  ephemeral?: boolean;
};

/* ── Permission config ─────────────────────────────────────────────── */

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
