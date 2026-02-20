/** Centralized environment variable access for server-side code. */

import { env } from '$env/dynamic/private';

export const PORT = Number(env.PORT ?? 8100);
export const ADMIN_TOKEN = env.ADMIN_TOKEN ?? "change-me-admin-token";
export const OPENCODE_CONFIG_PATH = env.OPENCODE_CONFIG_PATH ?? "/app/config/opencode.jsonc";
export const DATA_DIR = env.DATA_DIR ?? "/app/data";
export const CONTROLLER_URL = env.CONTROLLER_URL;
export const CONTROLLER_TOKEN = env.CONTROLLER_TOKEN ?? "";
export const GATEWAY_URL = env.GATEWAY_URL ?? "http://gateway:8080";
export const CADDYFILE_PATH = env.CADDYFILE_PATH ?? "/app/config/Caddyfile";
export const CHANNEL_ENV_DIR = env.CHANNEL_ENV_DIR ?? "/app/channel-env";
export const OPENCODE_CORE_URL = env.OPENCODE_CORE_URL ?? "http://opencode-core:4096";
export const OPENMEMORY_URL = env.OPENMEMORY_URL ?? "http://openmemory:8765";
export const CRON_DIR = env.CRON_DIR ?? "/app/config-root/cron";
export const RUNTIME_ENV_PATH = env.RUNTIME_ENV_PATH ?? "/workspace/.env";
export const SECRETS_ENV_PATH = env.SECRETS_ENV_PATH ?? "/app/config-root/secrets.env";

export const CHANNEL_SERVICES = ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"] as const;
export const CHANNEL_SERVICE_SET = new Set<string>(CHANNEL_SERVICES);
export const KNOWN_SERVICES = new Set<string>([
  "gateway", "controller", "opencode-core", "openmemory", "openmemory-ui",
  "admin", "caddy",
  "channel-chat", "channel-discord", "channel-voice", "channel-telegram"
]);

export const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  "channel-chat": ["CHAT_INBOUND_TOKEN"],
  "channel-discord": ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"],
  "channel-voice": [],
  "channel-telegram": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]
};

export const CHANNEL_FIELD_META: Record<string, { label: string; type: "text" | "password"; required: boolean; helpText?: string }> = {
  CHAT_INBOUND_TOKEN: { label: "Inbound Token", type: "password", required: false, helpText: "Token for authenticating incoming chat messages" },
  DISCORD_BOT_TOKEN: { label: "Bot Token", type: "password", required: true, helpText: "Create a bot at discord.com/developers and copy the token" },
  DISCORD_PUBLIC_KEY: { label: "Public Key", type: "text", required: true, helpText: "Found on the same page as your bot token" },
  TELEGRAM_BOT_TOKEN: { label: "Bot Token", type: "password", required: true, helpText: "Get a bot token from @BotFather on Telegram" },
  TELEGRAM_WEBHOOK_SECRET: { label: "Webhook Secret", type: "password", required: false, helpText: "A secret string to verify incoming webhook requests" },
};
