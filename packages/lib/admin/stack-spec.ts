import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const StackSpecVersion = 1;

export type StackAccessScope = "host" | "lan";
export type ChannelExposure = "lan" | "public";
export type StackChannelName = "chat" | "discord" | "voice" | "telegram";
export type ConnectionType = "ai_provider" | "platform" | "api_service";

export type StackChannelConfig = {
  enabled: boolean;
  exposure: ChannelExposure;
  config: Record<string, string>;
};

export type ChannelSecretMap = Record<StackChannelName, string>;

export type StackSecretsConfig = {
  gatewayChannelSecrets: ChannelSecretMap;
  channelServiceSecrets: ChannelSecretMap;
};

export type StackConnection = {
  id: string;
  type: ConnectionType;
  name: string;
  env: Record<string, string>;
};

export type StackAutomation = {
  id: string;
  name: string;
  schedule: string;
  script: string;
  enabled: boolean;
};

export type StackSpec = {
  version: typeof StackSpecVersion;
  accessScope: StackAccessScope;
  channels: Record<StackChannelName, StackChannelConfig>;
  secrets: StackSecretsConfig;
  connections: StackConnection[];
  automations: StackAutomation[];
};

const ChannelNames: StackChannelName[] = ["chat", "discord", "voice", "telegram"];
const ConnectionTypes: ConnectionType[] = ["ai_provider", "platform", "api_service"];

const ChannelConfigKeys: Record<StackChannelName, string[]> = {
  chat: ["CHAT_INBOUND_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"],
  voice: [],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
};

const DefaultChannelSecrets: ChannelSecretMap = {
  chat: "CHANNEL_CHAT_SECRET",
  discord: "CHANNEL_DISCORD_SECRET",
  voice: "CHANNEL_VOICE_SECRET",
  telegram: "CHANNEL_TELEGRAM_SECRET",
};

function defaultConnections(): StackConnection[] {
  return [];
}

function defaultAutomations(): StackAutomation[] {
  return [];
}

function defaultChannelConfig(channel: StackChannelName): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ChannelConfigKeys[channel]) result[key] = "";
  return result;
}

export function createDefaultStackSpec(): StackSpec {
  return {
    version: StackSpecVersion,
    accessScope: "lan",
    channels: {
      chat: { enabled: true, exposure: "lan", config: defaultChannelConfig("chat") },
      discord: { enabled: true, exposure: "lan", config: defaultChannelConfig("discord") },
      voice: { enabled: true, exposure: "lan", config: defaultChannelConfig("voice") },
      telegram: { enabled: true, exposure: "lan", config: defaultChannelConfig("telegram") },
    },
    secrets: {
      gatewayChannelSecrets: { ...DefaultChannelSecrets },
      channelServiceSecrets: { ...DefaultChannelSecrets },
    },
    connections: defaultConnections(),
    automations: defaultAutomations(),
  };
}

function assertRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function parseChannelConfig(raw: unknown, channelName: StackChannelName): Record<string, string> {
  const config = assertRecord(raw ?? {}, `invalid_channel_config_${channelName}`);
  const result = defaultChannelConfig(channelName);
  for (const key of ChannelConfigKeys[channelName]) {
    const value = config[key];
    if (value !== undefined && typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
    result[key] = typeof value === "string" ? value.trim() : "";
  }
  return result;
}

function parseChannel(raw: unknown, channelName: StackChannelName): StackChannelConfig {
  const channel = assertRecord(raw, `invalid_channel_${channelName}`);
  const enabled = channel.enabled;
  const exposure = channel.exposure;
  if (typeof enabled !== "boolean") throw new Error(`invalid_channel_enabled_${channelName}`);
  if (exposure !== "lan" && exposure !== "public") throw new Error(`invalid_channel_exposure_${channelName}`);
  return { enabled, exposure, config: parseChannelConfig(channel.config, channelName) };
}

function parseChannelSecretMap(raw: unknown, mapName: string): ChannelSecretMap {
  const map = assertRecord(raw, `invalid_${mapName}`);
  const result: Partial<ChannelSecretMap> = {};
  for (const channel of ChannelNames) {
    const value = map[channel];
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`invalid_secret_key_${mapName}_${channel}`);
    result[channel] = value.trim();
  }
  return result as ChannelSecretMap;
}

function parseConnections(raw: unknown): StackConnection[] {
  if (raw === undefined) return defaultConnections();
  if (!Array.isArray(raw)) throw new Error("invalid_connections");
  const unique = new Set<string>();
  return raw.map((value, index) => {
    const item = assertRecord(value, `invalid_connection_${index}`);
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const type = item.type;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const envRaw = assertRecord(item.env ?? {}, `invalid_connection_env_${index}`);
    if (!id) throw new Error(`invalid_connection_id_${index}`);
    if (!ConnectionTypes.includes(type as ConnectionType)) throw new Error(`invalid_connection_type_${index}`);
    if (!name) throw new Error(`invalid_connection_name_${index}`);
    if (unique.has(id)) throw new Error(`duplicate_connection_id_${id}`);
    unique.add(id);
    const envEntries = Object.entries(envRaw).filter((entry): entry is [string, unknown] => typeof entry[0] === "string");
    const env: Record<string, string> = {};
    for (const [envKey, envValue] of envEntries) {
      const key = envKey.trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid_connection_env_key_${key}`);
      if (typeof envValue !== "string" || envValue.trim().length === 0) throw new Error(`invalid_connection_env_value_${key}`);
      const secretRef = envValue.trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(secretRef)) throw new Error(`invalid_connection_secret_ref_${key}`);
      env[key] = secretRef;
    }
    if (Object.keys(env).length === 0) throw new Error(`missing_connection_env_${id}`);
    return { id, type: type as ConnectionType, name, env };
  });
}

function parseAutomations(raw: unknown): StackAutomation[] {
  if (raw === undefined) return defaultAutomations();
  if (!Array.isArray(raw)) throw new Error("invalid_automations");
  return raw.map((value, index) => {
    const automation = assertRecord(value, `invalid_automation_${index}`);
    const id = typeof automation.id === "string" ? automation.id.trim() : "";
    const name = typeof automation.name === "string" ? automation.name.trim() : "";
    const schedule = typeof automation.schedule === "string" ? automation.schedule.trim() : "";
    const script = typeof automation.script === "string" ? automation.script.trim() : "";
    const enabled = automation.enabled;
    if (!id) throw new Error(`invalid_automation_id_${index}`);
    if (!name) throw new Error(`invalid_automation_name_${index}`);
    if (!schedule) throw new Error(`invalid_automation_schedule_${index}`);
    if (!script) throw new Error(`invalid_automation_script_${index}`);
    if (typeof enabled !== "boolean") throw new Error(`invalid_automation_enabled_${index}`);
    return { id, name, schedule, script, enabled };
  });
}

export function parseStackSpec(raw: unknown): StackSpec {
  const doc = assertRecord(raw, "invalid_stack_spec");
  const version = doc.version;
  if (version !== 1 && version !== 2) throw new Error("invalid_stack_spec_version");
  if (doc.accessScope !== "host" && doc.accessScope !== "lan") throw new Error("invalid_access_scope");

  const channelsDoc = assertRecord(doc.channels, "missing_channels");
  const channels = {
    chat: parseChannel(channelsDoc.chat, "chat"),
    discord: parseChannel(channelsDoc.discord, "discord"),
    voice: parseChannel(channelsDoc.voice, "voice"),
    telegram: parseChannel(channelsDoc.telegram, "telegram"),
  };

  for (const key of Object.keys(channelsDoc)) {
    if (!ChannelNames.includes(key as StackChannelName)) throw new Error(`unknown_channel_${key}`);
  }

  const secretsDoc = assertRecord(doc.secrets ?? {}, "missing_secrets");
  const gatewayChannelSecrets = parseChannelSecretMap(secretsDoc.gatewayChannelSecrets ?? DefaultChannelSecrets, "gatewayChannelSecrets");
  const channelServiceSecrets = parseChannelSecretMap(secretsDoc.channelServiceSecrets ?? DefaultChannelSecrets, "channelServiceSecrets");

  const connections = parseConnections(doc.connections);
  const automations = parseAutomations(doc.automations);

  return {
    version: StackSpecVersion,
    accessScope: doc.accessScope,
    channels,
    secrets: {
      gatewayChannelSecrets,
      channelServiceSecrets,
    },
    connections,
    automations,
  };
}

export function stringifyStackSpec(spec: StackSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export function ensureStackSpec(path: string): StackSpec {
  if (!existsSync(path)) {
    const initial = createDefaultStackSpec();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stringifyStackSpec(initial), "utf8");
    return initial;
  }

  const content = readFileSync(path, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return parseStackSpec(parsed);
}

export function writeStackSpec(path: string, spec: StackSpec): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyStackSpec(spec), "utf8");
}

export function channelEnvSecretVariable(channel: StackChannelName): string {
  if (channel === "chat") return "CHANNEL_CHAT_SECRET";
  if (channel === "discord") return "CHANNEL_DISCORD_SECRET";
  if (channel === "voice") return "CHANNEL_VOICE_SECRET";
  return "CHANNEL_TELEGRAM_SECRET";
}
