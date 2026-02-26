import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_CHANNELS } from "../../assets/channels/index.ts";
import type { BuiltInChannelDef } from "../../assets/channels/index.ts";
import { parseYamlDocument, stringifyYamlDocument } from "../shared/yaml.ts";

export const StackSpecVersion = 3;

type StackAccessScope = "host" | "lan" | "public";
export type ChannelExposure = "host" | "lan" | "public";

type BuiltInChannelName = string;

export type StackChannelConfig = {
  enabled: boolean;
  exposure: ChannelExposure;
  template?: string;
  name?: string;
  description?: string;
  image?: string;
  containerPort?: number;
  hostPort?: number;
  rewritePath?: string;
  healthcheckPath?: string;
  sharedSecretEnv?: string;
  volumes?: string[];
  config: Record<string, string>;
};

export type StackSpec = {
  version: typeof StackSpecVersion;
  accessScope: StackAccessScope;
  ingressPort?: number;
  channels: Record<string, StackChannelConfig>;
};

const BuiltInChannelNames: BuiltInChannelName[] = Object.keys(BUILTIN_CHANNELS);

const BuiltInChannelConfigKeys: Record<BuiltInChannelName, string[]> = Object.fromEntries(
  Object.entries(BUILTIN_CHANNELS).map(([name, def]) => [name, def.env.map((e) => e.name)]),
) as Record<BuiltInChannelName, string[]>;

export const BuiltInChannelPorts: Record<BuiltInChannelName, number> = Object.fromEntries(
  Object.entries(BUILTIN_CHANNELS).map(([name, def]) => [name, def.containerPort]),
) as Record<BuiltInChannelName, number>;

export function getBuiltInChannelDef(name: BuiltInChannelName): BuiltInChannelDef {
  return BUILTIN_CHANNELS[name];
}

export function isBuiltInChannel(name: string): name is BuiltInChannelName {
  return BuiltInChannelNames.includes(name as BuiltInChannelName);
}

const IMAGE_PATTERN = /^[a-z0-9]+([._\/:@-][a-z0-9]+)*$/i;

function defaultChannelConfig(channel: BuiltInChannelName): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of BuiltInChannelConfigKeys[channel]) result[key] = "";
  return result;
}

function defaultChannelEntry(channelName: string): StackChannelConfig {
  const builtIn = BUILTIN_CHANNELS[channelName];
  const config = defaultChannelConfig(channelName);
  return {
    enabled: true,
    exposure: "lan",
    template: channelName,
    containerPort: builtIn.containerPort,
    rewritePath: builtIn.rewritePath,
    sharedSecretEnv: builtIn.sharedSecretEnv,
    config,
  };
}

export function createDefaultStackSpec(): StackSpec {
  return {
    version: StackSpecVersion,
    accessScope: "lan",
    channels: Object.fromEntries(BuiltInChannelNames.map((name) => [name, defaultChannelEntry(name)])),
  };
}

const VALID_SCOPES = new Set<string>(["host", "lan", "public"]);

function assertRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`invalid_${fieldName}`);
  return value.trim() || undefined;
}

function parseOptionalStringArray(value: unknown, errorCode: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(errorCode);
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${errorCode}_entry`);
  }
  return value.map((v: string) => v.trim());
}

function parsePort(value: unknown, errorCode: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error(errorCode);
  return value;
}

function parseImage(value: unknown, errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(errorCode);
  if (!IMAGE_PATTERN.test(value.trim())) throw new Error(`${errorCode}_format`);
  return value.trim();
}

function parseOptionalNonEmptyString(value: unknown, errorCode: string, validator?: (v: string) => boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(errorCode);
  const trimmed = value.trim();
  if (validator && !validator(trimmed)) throw new Error(errorCode);
  return trimmed;
}

function spread<K extends string, V>(key: K, value: V | undefined): Record<K, V> | {} {
  return value !== undefined ? { [key]: value } as Record<K, V> : {};
}

function parseOpenConfig(raw: unknown, scope: string): Record<string, string> {
  const config = assertRecord(raw ?? {}, `invalid_${scope}_config`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.trim()) throw new Error(`invalid_${scope}_config_key_empty`);
    if (typeof value !== "string") throw new Error(`invalid_${scope}_config_value_${key}`);
    result[key] = value.replace(/[\r\n]+/g, "").trim();
  }
  return result;
}

function parseChannelConfig(raw: unknown, channelName: string): Record<string, string> {
  if (!isBuiltInChannel(channelName)) return parseOpenConfig(raw, `channel_${channelName}`);
  const config = assertRecord(raw ?? {}, `invalid_channel_config_${channelName}`);
  const result = defaultChannelConfig(channelName);
  for (const key of BuiltInChannelConfigKeys[channelName]) {
    const value = config[key];
    if (value !== undefined && typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
    result[key] = typeof value === "string" ? value.replace(/[\r\n]+/g, "").trim() : "";
  }
  return result;
}

function parseChannel(raw: unknown, channelName: string): StackChannelConfig {
  const ch = assertRecord(raw, `invalid_channel_${channelName}`);
  if (typeof ch.enabled !== "boolean") throw new Error(`invalid_channel_enabled_${channelName}`);
  if (!VALID_SCOPES.has(ch.exposure as string)) throw new Error(`invalid_channel_exposure_${channelName}`);

  const n = channelName; // short alias for error codes
  return {
    enabled: ch.enabled,
    exposure: ch.exposure as ChannelExposure,
    config: parseChannelConfig(ch.config, n),
    ...spread("template", parseOptionalString(ch.template, `channel_template_${n}`)),
    ...spread("name", parseOptionalString(ch.name, `channel_name_${n}`)),
    ...spread("description", parseOptionalString(ch.description, `channel_description_${n}`)),
    ...spread("image", parseImage(ch.image, `invalid_channel_image_${n}`)),
    ...spread("containerPort", parsePort(ch.containerPort, `invalid_channel_container_port_${n}`)),
    ...spread("hostPort", parsePort(ch.hostPort, `invalid_channel_host_port_${n}`)),
    ...spread("rewritePath", parseOptionalNonEmptyString(ch.rewritePath, `invalid_channel_rewrite_path_${n}`, (v) => v.startsWith("/"))),
    ...spread("healthcheckPath", parseOptionalString(ch.healthcheckPath, `invalid_channel_healthcheck_path_${n}`)),
    ...spread("sharedSecretEnv", parseOptionalNonEmptyString(ch.sharedSecretEnv, `invalid_channel_shared_secret_env_${n}`)),
    ...spread("volumes", parseOptionalStringArray(ch.volumes, `invalid_channel_volumes_${n}`)),
  };
}

export function parseStackSpec(raw: unknown): StackSpec {
  const doc = assertRecord(raw, "invalid_stack_spec");
  const allowedKeys = new Set(["version", "accessScope", "ingressPort", "channels"]);
  for (const key of Object.keys(doc)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown_stack_spec_field_${key}`);
  }
  const version = doc.version;
  if (version !== 3) throw new Error("invalid_stack_spec_version");
  if (!VALID_SCOPES.has(doc.accessScope as string)) throw new Error("invalid_access_scope");

  const channelsDoc = assertRecord(doc.channels, "missing_channels");
  const channels: Record<string, StackChannelConfig> = {};
  for (const [name, value] of Object.entries(channelsDoc)) {
    if (!name.trim()) throw new Error(`invalid_channel_name_${name}`);
    channels[name] = parseChannel(value, name);
  }

  return {
    version: StackSpecVersion,
    accessScope: doc.accessScope as StackAccessScope,
    channels,
    ...spread("ingressPort", parsePort(doc.ingressPort, "invalid_ingress_port")),
  };
}

export function stringifyStackSpec(spec: StackSpec): string {
  return `${stringifyYamlDocument(spec)}\n`;
}

export function ensureStackSpec(path: string): StackSpec {
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    return parseStackSpec(parseYamlDocument(content));
  }

  // Create default
  const initial = createDefaultStackSpec();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyStackSpec(initial), "utf8");
  return initial;
}

export function parseSecretReference(value: string): string | null {
  const match = value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
  if (!match) return null;
  return match[1];
}
