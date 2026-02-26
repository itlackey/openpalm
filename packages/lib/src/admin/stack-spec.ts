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
  supportsMultipleInstances?: boolean;
  name?: string;
  description?: string;
  image?: string;
  containerPort?: number;
  hostPort?: number;
  domains?: string[];
  pathPrefixes?: string[];
  rewritePath?: string;
  healthcheckPath?: string;
  sharedSecretEnv?: string;
  volumes?: string[];
  config: Record<string, string>;
};

export type StackServiceConfig = {
  enabled: boolean;
  template?: string;
  supportsMultipleInstances?: boolean;
  name?: string;
  description?: string;
  image: string;
  containerPort: number;
  healthcheckPath?: string;
  volumes?: string[];
  dependsOn?: string[];
  config: Record<string, string>;
};

type CaddyConfig = {
  email?: string;
};

export type StackSpec = {
  version: typeof StackSpecVersion;
  accessScope: StackAccessScope;
  ingressPort?: number;
  caddy?: CaddyConfig;
  channels: Record<string, StackChannelConfig>;
  services: Record<string, StackServiceConfig>;
};

// --- Derive built-in channel data from YAML snippets ---

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

// --- Validation patterns for user-provided values that flow into generated configs ---

/** Domain: alphanumeric labels separated by dots, optional wildcard prefix, 2+ char TLD. Max 253 chars per RFC 1035. */
const DOMAIN_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

/** Path prefix: must start with /, only alphanumeric plus / _ - allowed. No whitespace, no Caddy metacharacters. */
const PATH_PREFIX_PATTERN = /^\/[a-z0-9\/_-]*$/i;

/** Docker image name: registry/namespace/name:tag or @sha256 digest. No whitespace or YAML metacharacters. */
const IMAGE_PATTERN = /^[a-z0-9]+([._\/:@-][a-z0-9]+)*$/i;

/** Email: basic validation — no whitespace, newlines, or Caddy metacharacters. */
const EMAIL_PATTERN = /^[^\s{}"#]+@[^\s{}"#]+\.[^\s{}"#]+$/;

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
    services: {},
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

function parseOptionalBoolean(value: unknown, errorCode: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(errorCode);
  return value;
}

function parsePort(value: unknown, errorCode: string, required: true): number;
function parsePort(value: unknown, errorCode: string, required?: false): number | undefined;
function parsePort(value: unknown, errorCode: string, required?: boolean): number | undefined {
  if (value === undefined) { if (required) throw new Error(errorCode); return undefined; }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error(errorCode);
  return value;
}

function parseImage(value: unknown, errorCode: string, required: true): string;
function parseImage(value: unknown, errorCode: string, required?: false): string | undefined;
function parseImage(value: unknown, errorCode: string, required?: boolean): string | undefined {
  if (value === undefined) { if (required) throw new Error(errorCode); return undefined; }
  if (typeof value !== "string" || !value.trim()) throw new Error(errorCode);
  if (!IMAGE_PATTERN.test(value.trim())) throw new Error(`${errorCode}_format`);
  return value.trim();
}

function parseOptionalDomains(value: unknown, errorCode: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(errorCode);
  for (const d of value) {
    if (typeof d !== "string" || !d.trim()) throw new Error(`${errorCode}_entry`);
    if (!DOMAIN_PATTERN.test(d.trim())) throw new Error(`${errorCode}_format`);
    if (d.trim().length > 253) throw new Error(`${errorCode}_length`);
  }
  return value.map((d: string) => d.trim());
}

function parseOptionalPathPrefixes(value: unknown, errorCode: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(errorCode);
  for (const p of value) {
    if (typeof p !== "string" || !p.trim()) throw new Error(`${errorCode}_entry`);
    if (!PATH_PREFIX_PATTERN.test(p.trim())) throw new Error(`${errorCode}_format`);
  }
  return value.map((p: string) => p.trim());
}


function parseOptionalNonEmptyString(value: unknown, errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(errorCode);
  return value.trim();
}

function parseOptionalRewritePath(value: unknown, errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(errorCode);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) throw new Error(errorCode);
  return trimmed;
}

/** Conditionally include a key in an object spread — returns {} when value is undefined. */
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
    ...spread("supportsMultipleInstances", parseOptionalBoolean(ch.supportsMultipleInstances, `invalid_channel_supports_multiple_instances_${n}`)),
    ...spread("name", parseOptionalString(ch.name, `channel_name_${n}`)),
    ...spread("description", parseOptionalString(ch.description, `channel_description_${n}`)),
    ...spread("image", parseImage(ch.image, `invalid_channel_image_${n}`)),
    ...spread("containerPort", parsePort(ch.containerPort, `invalid_channel_container_port_${n}`)),
    ...spread("hostPort", parsePort(ch.hostPort, `invalid_channel_host_port_${n}`)),
    ...spread("domains", parseOptionalDomains(ch.domains, `invalid_channel_domain_${n}`)),
    ...spread("pathPrefixes", parseOptionalPathPrefixes(ch.pathPrefixes, `invalid_channel_path_prefix_${n}`)),
    ...spread("rewritePath", parseOptionalRewritePath(ch.rewritePath, `invalid_channel_rewrite_path_${n}`)),
    ...spread("healthcheckPath", parseOptionalString(ch.healthcheckPath, `invalid_channel_healthcheck_path_${n}`)),
    ...spread("sharedSecretEnv", parseOptionalNonEmptyString(ch.sharedSecretEnv, `invalid_channel_shared_secret_env_${n}`)),
    ...spread("volumes", parseOptionalStringArray(ch.volumes, `invalid_channel_volumes_${n}`)),
  };
}

function parseService(raw: unknown, serviceName: string): StackServiceConfig {
  const svc = assertRecord(raw, `invalid_service_${serviceName}`);
  if (typeof svc.enabled !== "boolean") throw new Error(`invalid_service_enabled_${serviceName}`);

  const n = serviceName; // short alias for error codes
  return {
    enabled: svc.enabled,
    image: parseImage(svc.image, `invalid_service_image_${n}`, true),
    containerPort: parsePort(svc.containerPort, `invalid_service_container_port_${n}`, true),
    config: parseOpenConfig(svc.config, `service_${n}`),
    ...spread("template", parseOptionalString(svc.template, `service_template_${n}`)),
    ...spread("supportsMultipleInstances", parseOptionalBoolean(svc.supportsMultipleInstances, `invalid_service_supports_multiple_instances_${n}`)),
    ...spread("name", parseOptionalString(svc.name, `service_name_${n}`)),
    ...spread("description", parseOptionalString(svc.description, `service_description_${n}`)),
    ...spread("volumes", parseOptionalStringArray(svc.volumes, `invalid_service_volumes_${n}`)),
    ...spread("healthcheckPath", parseOptionalString(svc.healthcheckPath, `invalid_service_healthcheck_path_${n}`)),
    ...spread("dependsOn", parseOptionalStringArray(svc.dependsOn, `invalid_service_depends_on_${n}`)),
  };
}

function parseServices(raw: unknown): Record<string, StackServiceConfig> {
  if (raw === undefined) return {};
  const doc = assertRecord(raw, "invalid_services");
  const services: Record<string, StackServiceConfig> = {};
  for (const [name, value] of Object.entries(doc)) {
    if (!name.trim()) throw new Error(`invalid_service_name_${name}`);
    services[name] = parseService(value, name);
  }
  return services;
}

function parseCaddyConfig(raw: unknown): CaddyConfig | undefined {
  if (raw === undefined) return undefined;
  const doc = assertRecord(raw, "invalid_caddy_config");
  const caddy: CaddyConfig = {};
  if (doc.email !== undefined) {
    if (typeof doc.email !== "string") throw new Error("invalid_caddy_email");
    if (!EMAIL_PATTERN.test(doc.email.trim())) throw new Error("invalid_caddy_email_format");
    caddy.email = doc.email.trim();
  }
  return caddy;
}

export function parseStackSpec(raw: unknown): StackSpec {
  const doc = assertRecord(raw, "invalid_stack_spec");
  const allowedKeys = new Set(["version", "accessScope", "ingressPort", "caddy", "channels", "services"]);
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
    services: parseServices(doc.services),
    ...spread("ingressPort", parsePort(doc.ingressPort, "invalid_ingress_port")),
    ...spread("caddy", parseCaddyConfig(doc.caddy)),
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
