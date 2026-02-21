import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const StackSpecVersion = 2;

export type StackAccessScope = "host" | "lan" | "public";
export type ChannelExposure = "host" | "lan" | "public";

/** Built-in channel names that have known defaults for image, port, and config keys. */
export type BuiltInChannelName = "chat" | "discord" | "voice" | "telegram";

/** @deprecated Use string keys with isBuiltInChannel() for new code. Kept for backward compatibility. */
export type StackChannelName = BuiltInChannelName;

export type StackChannelConfig = {
  enabled: boolean;
  exposure: ChannelExposure;
  image?: string;
  containerPort?: number;
  hostPort?: number;
  domains?: string[];
  pathPrefixes?: string[];
  config: Record<string, string>;
};

export type CaddyConfig = {
  email?: string;
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
  caddy?: CaddyConfig;
  channels: Record<string, StackChannelConfig>;
  automations: StackAutomation[];
};

export const BuiltInChannelNames: BuiltInChannelName[] = ["chat", "discord", "voice", "telegram"];

export const BuiltInChannelConfigKeys: Record<BuiltInChannelName, string[]> = {
  chat: ["CHAT_INBOUND_TOKEN", "CHANNEL_CHAT_SECRET"],
  discord: ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "CHANNEL_DISCORD_SECRET"],
  voice: ["CHANNEL_VOICE_SECRET"],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "CHANNEL_TELEGRAM_SECRET"],
};

export const BuiltInChannelPorts: Record<BuiltInChannelName, number> = {
  chat: 8181,
  discord: 8184,
  voice: 8183,
  telegram: 8182,
};

export function isBuiltInChannel(name: string): name is BuiltInChannelName {
  return BuiltInChannelNames.includes(name as BuiltInChannelName);
}

function defaultAutomations(): StackAutomation[] {
  return [];
}

function defaultChannelConfig(channel: BuiltInChannelName): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of BuiltInChannelConfigKeys[channel]) result[key] = "";
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
    automations: defaultAutomations(),
  };
}

function assertRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function parseChannelConfig(raw: unknown, channelName: string): Record<string, string> {
  const config = assertRecord(raw ?? {}, `invalid_channel_config_${channelName}`);

  if (isBuiltInChannel(channelName)) {
    const result = defaultChannelConfig(channelName);
    for (const key of BuiltInChannelConfigKeys[channelName]) {
      const value = config[key];
      if (value !== undefined && typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
      result[key] = typeof value === "string" ? value.trim() : "";
    }
    return result;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
    result[key] = value.trim();
  }
  return result;
}

function parseChannel(raw: unknown, channelName: string): StackChannelConfig {
  const channel = assertRecord(raw, `invalid_channel_${channelName}`);
  const enabled = channel.enabled;
  const exposure = channel.exposure;
  if (typeof enabled !== "boolean") throw new Error(`invalid_channel_enabled_${channelName}`);
  if (exposure !== "host" && exposure !== "lan" && exposure !== "public") throw new Error(`invalid_channel_exposure_${channelName}`);

  const result: StackChannelConfig = {
    enabled,
    exposure,
    config: parseChannelConfig(channel.config, channelName),
  };

  if (channel.image !== undefined) {
    if (typeof channel.image !== "string" || !channel.image.trim()) throw new Error(`invalid_channel_image_${channelName}`);
    result.image = channel.image.trim();
  }
  if (channel.containerPort !== undefined) {
    if (typeof channel.containerPort !== "number" || !Number.isInteger(channel.containerPort) || channel.containerPort < 1 || channel.containerPort > 65535) {
      throw new Error(`invalid_channel_container_port_${channelName}`);
    }
    result.containerPort = channel.containerPort;
  }
  if (channel.hostPort !== undefined) {
    if (typeof channel.hostPort !== "number" || !Number.isInteger(channel.hostPort) || channel.hostPort < 1 || channel.hostPort > 65535) {
      throw new Error(`invalid_channel_host_port_${channelName}`);
    }
    result.hostPort = channel.hostPort;
  }
  if (channel.domains !== undefined) {
    if (!Array.isArray(channel.domains)) throw new Error(`invalid_channel_domains_${channelName}`);
    for (const d of channel.domains) {
      if (typeof d !== "string" || !d.trim()) throw new Error(`invalid_channel_domain_entry_${channelName}`);
    }
    result.domains = channel.domains.map((d: string) => d.trim());
  }
  if (channel.pathPrefixes !== undefined) {
    if (!Array.isArray(channel.pathPrefixes)) throw new Error(`invalid_channel_path_prefixes_${channelName}`);
    for (const p of channel.pathPrefixes) {
      if (typeof p !== "string" || !p.trim()) throw new Error(`invalid_channel_path_prefix_entry_${channelName}`);
    }
    result.pathPrefixes = channel.pathPrefixes.map((p: string) => p.trim());
  }

  if (!isBuiltInChannel(channelName)) {
    if (!result.image) throw new Error(`custom_channel_requires_image_${channelName}`);
    if (!result.containerPort) throw new Error(`custom_channel_requires_container_port_${channelName}`);
  }

  return result;
}

function parseCaddyConfig(raw: unknown): CaddyConfig | undefined {
  if (raw === undefined) return undefined;
  const doc = assertRecord(raw, "invalid_caddy_config");
  const caddy: CaddyConfig = {};
  if (doc.email !== undefined) {
    if (typeof doc.email !== "string") throw new Error("invalid_caddy_email");
    caddy.email = doc.email.trim();
  }
  return caddy;
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
  const allowedKeys = new Set(["version", "accessScope", "caddy", "channels", "automations"]);
  for (const key of Object.keys(doc)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown_stack_spec_field_${key}`);
  }
  const version = doc.version;
  if (version !== 1 && version !== 2) throw new Error("invalid_stack_spec_version");
  if (doc.accessScope !== "host" && doc.accessScope !== "lan" && doc.accessScope !== "public") throw new Error("invalid_access_scope");

  const caddy = parseCaddyConfig(doc.caddy);

  const channelsDoc = assertRecord(doc.channels, "missing_channels");

  for (const name of BuiltInChannelNames) {
    if (channelsDoc[name] === undefined) throw new Error(`missing_built_in_channel_${name}`);
  }

  const channels: Record<string, StackChannelConfig> = {};
  for (const [name, value] of Object.entries(channelsDoc)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid_channel_name_${name}`);
    channels[name] = parseChannel(value, name);
  }

  const automations = parseAutomations(doc.automations);

  return {
    version: StackSpecVersion,
    accessScope: doc.accessScope,
    caddy,
    channels,
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

export function parseSecretReference(value: string): string | null {
  const match = value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
  if (!match) return null;
  return match[1];
}
