import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_CHANNELS } from "../../assets/channels/index.ts";
import type { BuiltInChannelDef } from "../../assets/channels/index.ts";
import { parseYamlDocument, stringifyYamlDocument } from "../shared/yaml.ts";

export const StackSpecVersion = 3;

export type StackAccessScope = "host" | "lan" | "public";
export type ChannelExposure = "host" | "lan" | "public";

export type BuiltInChannelName = string;

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

export type CaddyConfig = {
  email?: string;
};

export type StackAutomation = {
  id: string;
  name: string;
  description?: string;
  schedule: string;
  script: string;
  enabled: boolean;
  core?: boolean;
};

export type StackSpec = {
  version: typeof StackSpecVersion;
  accessScope: StackAccessScope;
  ingressPort?: number;
  caddy?: CaddyConfig;
  channels: Record<string, StackChannelConfig>;
  services: Record<string, StackServiceConfig>;
  automations: StackAutomation[];
};

// --- Derive built-in channel data from YAML snippets ---

export const BuiltInChannelNames: BuiltInChannelName[] = Object.keys(BUILTIN_CHANNELS);

export const BuiltInChannelConfigKeys: Record<BuiltInChannelName, string[]> = Object.fromEntries(
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

function defaultAutomations(): StackAutomation[] {
  return [];
}

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
    automations: defaultAutomations(),
  };
}

function assertRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`invalid_${fieldName}`);
  return value.trim() || undefined;
}

function parseOptionalVolumes(value: unknown, errorCode: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(errorCode);
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) throw new Error(errorCode);
  }
  return value.map((v: string) => v.trim());
}

function parseChannelConfig(raw: unknown, channelName: string): Record<string, string> {
  const config = assertRecord(raw ?? {}, `invalid_channel_config_${channelName}`);

  if (isBuiltInChannel(channelName)) {
    const result = defaultChannelConfig(channelName);
    for (const key of BuiltInChannelConfigKeys[channelName]) {
      const value = config[key];
      if (value !== undefined && typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
      result[key] = typeof value === "string" ? value.replace(/[\r\n]+/g, "").trim() : "";
    }
    return result;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.trim()) throw new Error(`invalid_channel_config_key_${channelName}_empty`);
    if (typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
    result[key] = value.replace(/[\r\n]+/g, "").trim();
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

  const template = parseOptionalString(channel.template, `channel_template_${channelName}`);
  if (template) result.template = template;
  if (channel.supportsMultipleInstances !== undefined) {
    if (typeof channel.supportsMultipleInstances !== "boolean") throw new Error(`invalid_channel_supports_multiple_instances_${channelName}`);
    result.supportsMultipleInstances = channel.supportsMultipleInstances;
  }

  const name = parseOptionalString(channel.name, `channel_name_${channelName}`);
  if (name) result.name = name;

  const description = parseOptionalString(channel.description, `channel_description_${channelName}`);
  if (description) result.description = description;

  if (channel.image !== undefined) {
    if (typeof channel.image !== "string" || !channel.image.trim()) throw new Error(`invalid_channel_image_${channelName}`);
    if (!IMAGE_PATTERN.test(channel.image.trim())) throw new Error(`invalid_channel_image_format_${channelName}`);
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
      if (!DOMAIN_PATTERN.test(d.trim())) throw new Error(`invalid_channel_domain_format_${channelName}`);
      if (d.trim().length > 253) throw new Error(`invalid_channel_domain_length_${channelName}`);
    }
    result.domains = channel.domains.map((d: string) => d.trim());
  }
  if (channel.pathPrefixes !== undefined) {
    if (!Array.isArray(channel.pathPrefixes)) throw new Error(`invalid_channel_path_prefixes_${channelName}`);
    for (const p of channel.pathPrefixes) {
      if (typeof p !== "string" || !p.trim()) throw new Error(`invalid_channel_path_prefix_entry_${channelName}`);
      if (!PATH_PREFIX_PATTERN.test(p.trim())) throw new Error(`invalid_channel_path_prefix_format_${channelName}`);
    }
    result.pathPrefixes = channel.pathPrefixes.map((p: string) => p.trim());
  }

  if (channel.rewritePath !== undefined) {
    if (typeof channel.rewritePath !== "string" || !channel.rewritePath.trim()) throw new Error(`invalid_channel_rewrite_path_${channelName}`);
    const rewritePath = channel.rewritePath.trim();
    if (!rewritePath.startsWith("/")) throw new Error(`invalid_channel_rewrite_path_${channelName}`);
    result.rewritePath = rewritePath;
  }

  const healthcheckPath = parseOptionalString(channel.healthcheckPath, `invalid_channel_healthcheck_path_${channelName}`);
  if (healthcheckPath) result.healthcheckPath = healthcheckPath;

  if (channel.sharedSecretEnv !== undefined) {
    if (typeof channel.sharedSecretEnv !== "string" || !channel.sharedSecretEnv.trim()) throw new Error(`invalid_channel_shared_secret_env_${channelName}`);
    result.sharedSecretEnv = channel.sharedSecretEnv.trim();
  }

  const volumes = parseOptionalVolumes(channel.volumes, `invalid_channel_volumes_${channelName}`);
  if (volumes) result.volumes = volumes;

  return result;
}

function parseServiceConfig(raw: unknown, serviceName: string): Record<string, string> {
  const config = assertRecord(raw ?? {}, `invalid_service_config_${serviceName}`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.trim()) throw new Error(`invalid_service_config_key_${serviceName}_empty`);
    if (typeof value !== "string") throw new Error(`invalid_service_config_value_${serviceName}_${key}`);
    result[key] = value.replace(/[\r\n]+/g, "").trim();
  }
  return result;
}

function parseService(raw: unknown, serviceName: string): StackServiceConfig {
  const service = assertRecord(raw, `invalid_service_${serviceName}`);

  const enabled = service.enabled;
  if (typeof enabled !== "boolean") throw new Error(`invalid_service_enabled_${serviceName}`);

  const image = service.image;
  if (typeof image !== "string" || !image.trim()) throw new Error(`invalid_service_image_${serviceName}`);
  if (!IMAGE_PATTERN.test(image.trim())) throw new Error(`invalid_service_image_format_${serviceName}`);

  const containerPort = service.containerPort;
  if (typeof containerPort !== "number" || !Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw new Error(`invalid_service_container_port_${serviceName}`);
  }

  const result: StackServiceConfig = {
    enabled,
    image: image.trim(),
    containerPort,
    config: parseServiceConfig(service.config, serviceName),
  };

  const template = parseOptionalString(service.template, `service_template_${serviceName}`);
  if (template) result.template = template;
  if (service.supportsMultipleInstances !== undefined) {
    if (typeof service.supportsMultipleInstances !== "boolean") throw new Error(`invalid_service_supports_multiple_instances_${serviceName}`);
    result.supportsMultipleInstances = service.supportsMultipleInstances;
  }

  const name = parseOptionalString(service.name, `service_name_${serviceName}`);
  if (name) result.name = name;

  const description = parseOptionalString(service.description, `service_description_${serviceName}`);
  if (description) result.description = description;

  const volumes = parseOptionalVolumes(service.volumes, `invalid_service_volumes_${serviceName}`);
  if (volumes) result.volumes = volumes;

  const healthcheckPath = parseOptionalString(service.healthcheckPath, `invalid_service_healthcheck_path_${serviceName}`);
  if (healthcheckPath) result.healthcheckPath = healthcheckPath;

  if (service.dependsOn !== undefined) {
    if (!Array.isArray(service.dependsOn)) throw new Error(`invalid_service_depends_on_${serviceName}`);
    for (const dep of service.dependsOn) {
      if (typeof dep !== "string" || !dep.trim()) throw new Error(`invalid_service_depends_on_entry_${serviceName}`);
    }
    result.dependsOn = service.dependsOn.map((d: string) => d.trim());
  }

  return result;
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
    const result: StackAutomation = { id, name, schedule, script, enabled };
    const description = parseOptionalString(automation.description, `automation_description_${index}`);
    if (description) result.description = description;
    if (automation.core === true) result.core = true;
    return result;
  });
}

export function parseStackSpec(raw: unknown): StackSpec {
  const doc = assertRecord(raw, "invalid_stack_spec");
  const allowedKeys = new Set(["version", "accessScope", "ingressPort", "caddy", "channels", "services", "automations"]);
  for (const key of Object.keys(doc)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown_stack_spec_field_${key}`);
  }
  const version = doc.version;
  if (version !== 3) throw new Error("invalid_stack_spec_version");
  if (doc.accessScope !== "host" && doc.accessScope !== "lan" && doc.accessScope !== "public") throw new Error("invalid_access_scope");

  let ingressPort: number | undefined;
  if (doc.ingressPort !== undefined) {
    if (typeof doc.ingressPort !== "number" || !Number.isInteger(doc.ingressPort) || doc.ingressPort < 1 || doc.ingressPort > 65535) {
      throw new Error("invalid_ingress_port");
    }
    ingressPort = doc.ingressPort;
  }

  const caddy = parseCaddyConfig(doc.caddy);

  const channelsDoc = assertRecord(doc.channels, "missing_channels");

  const channels: Record<string, StackChannelConfig> = {};
  for (const [name, value] of Object.entries(channelsDoc)) {
    if (!name.trim()) throw new Error(`invalid_channel_name_${name}`);
    channels[name] = parseChannel(value, name);
  }

  const services = parseServices(doc.services);
  const automations = parseAutomations(doc.automations);

  const result: StackSpec = {
    version: StackSpecVersion,
    accessScope: doc.accessScope,
    channels,
    services,
    automations,
  };
  if (ingressPort !== undefined) result.ingressPort = ingressPort;
  if (caddy) result.caddy = caddy;
  return result;
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

export function writeStackSpec(path: string, spec: StackSpec): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyStackSpec(spec), "utf8");
}

export function parseSecretReference(value: string): string | null {
  const match = value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
  if (!match) return null;
  return match[1];
}
