import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { B as BUILTIN_CHANNELS, s as stringifyYamlDocument, a as parseYamlDocument } from "./index.js";
if (typeof globalThis.Bun === "undefined") {
  globalThis.Bun = {
    env: typeof process !== "undefined" ? process.env : {},
    spawn() {
      throw new Error("Bun.spawn not available in Node");
    },
    spawnSync() {
      throw new Error("Bun.spawnSync not available in Node");
    }
  };
}
const LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function getMinLevel() {
  if (Bun.env.DEBUG === "1") return "debug";
  const raw = Bun.env.LOG_LEVEL;
  if (raw && raw in LEVEL_PRIORITY) return raw;
  return "info";
}
function shouldLog(level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
}
function emit(level, service, msg, extra) {
  if (!shouldLog(level)) return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    service,
    msg
  };
  if (extra !== void 0 && Object.keys(extra).length > 0) {
    entry.extra = extra;
  }
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
function createLogger(service) {
  return {
    debug(msg, extra) {
      emit("debug", service, msg, extra);
    },
    info(msg, extra) {
      emit("info", service, msg, extra);
    },
    warn(msg, extra) {
      emit("warn", service, msg, extra);
    },
    error(msg, extra) {
      emit("error", service, msg, extra);
    }
  };
}
const StackSpecVersion = 3;
const BuiltInChannelNames = Object.keys(BUILTIN_CHANNELS);
const BuiltInChannelConfigKeys = Object.fromEntries(
  Object.entries(BUILTIN_CHANNELS).map(([name, def]) => [name, def.env.map((e) => e.name)])
);
const BuiltInChannelPorts = Object.fromEntries(
  Object.entries(BUILTIN_CHANNELS).map(([name, def]) => [name, def.containerPort])
);
function getBuiltInChannelDef(name) {
  return BUILTIN_CHANNELS[name];
}
function isBuiltInChannel(name) {
  return BuiltInChannelNames.includes(name);
}
const DOMAIN_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const PATH_PREFIX_PATTERN = /^\/[a-z0-9\/_-]*$/i;
const IMAGE_PATTERN = /^[a-z0-9]+([._\/:@-][a-z0-9]+)*$/i;
const EMAIL_PATTERN = /^[^\s{}"#]+@[^\s{}"#]+\.[^\s{}"#]+$/;
function defaultAutomations() {
  return [];
}
function defaultChannelConfig(channel) {
  const result = {};
  for (const key of BuiltInChannelConfigKeys[channel]) result[key] = "";
  return result;
}
function defaultChannelEntry(channelName) {
  const builtIn = BUILTIN_CHANNELS[channelName];
  const config = defaultChannelConfig(channelName);
  return {
    enabled: true,
    exposure: "lan",
    template: channelName,
    containerPort: builtIn.containerPort,
    rewritePath: builtIn.rewritePath,
    sharedSecretEnv: builtIn.sharedSecretEnv,
    config
  };
}
function createDefaultStackSpec() {
  return {
    version: StackSpecVersion,
    accessScope: "lan",
    channels: Object.fromEntries(BuiltInChannelNames.map((name) => [name, defaultChannelEntry(name)])),
    services: {},
    automations: defaultAutomations()
  };
}
function assertRecord(value, errorCode) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(errorCode);
  return value;
}
function parseOptionalString(value, fieldName) {
  if (value === void 0) return void 0;
  if (typeof value !== "string") throw new Error(`invalid_${fieldName}`);
  return value.trim() || void 0;
}
function parseOptionalVolumes(value, errorCode) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new Error(errorCode);
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) throw new Error(errorCode);
  }
  return value.map((v) => v.trim());
}
function parseChannelConfig(raw, channelName) {
  const config = assertRecord(raw ?? {}, `invalid_channel_config_${channelName}`);
  if (isBuiltInChannel(channelName)) {
    const result2 = defaultChannelConfig(channelName);
    for (const key of BuiltInChannelConfigKeys[channelName]) {
      const value = config[key];
      if (value !== void 0 && typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
      result2[key] = typeof value === "string" ? value.replace(/[\r\n]+/g, "").trim() : "";
    }
    return result2;
  }
  const result = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.trim()) throw new Error(`invalid_channel_config_key_${channelName}_empty`);
    if (typeof value !== "string") throw new Error(`invalid_channel_config_value_${channelName}_${key}`);
    result[key] = value.replace(/[\r\n]+/g, "").trim();
  }
  return result;
}
function parseChannel(raw, channelName) {
  const channel = assertRecord(raw, `invalid_channel_${channelName}`);
  const enabled = channel.enabled;
  const exposure = channel.exposure;
  if (typeof enabled !== "boolean") throw new Error(`invalid_channel_enabled_${channelName}`);
  if (exposure !== "host" && exposure !== "lan" && exposure !== "public") throw new Error(`invalid_channel_exposure_${channelName}`);
  const result = {
    enabled,
    exposure,
    config: parseChannelConfig(channel.config, channelName)
  };
  const template = parseOptionalString(channel.template, `channel_template_${channelName}`);
  if (template) result.template = template;
  if (channel.supportsMultipleInstances !== void 0) {
    if (typeof channel.supportsMultipleInstances !== "boolean") throw new Error(`invalid_channel_supports_multiple_instances_${channelName}`);
    result.supportsMultipleInstances = channel.supportsMultipleInstances;
  }
  const name = parseOptionalString(channel.name, `channel_name_${channelName}`);
  if (name) result.name = name;
  const description = parseOptionalString(channel.description, `channel_description_${channelName}`);
  if (description) result.description = description;
  if (channel.image !== void 0) {
    if (typeof channel.image !== "string" || !channel.image.trim()) throw new Error(`invalid_channel_image_${channelName}`);
    if (!IMAGE_PATTERN.test(channel.image.trim())) throw new Error(`invalid_channel_image_format_${channelName}`);
    result.image = channel.image.trim();
  }
  if (channel.containerPort !== void 0) {
    if (typeof channel.containerPort !== "number" || !Number.isInteger(channel.containerPort) || channel.containerPort < 1 || channel.containerPort > 65535) {
      throw new Error(`invalid_channel_container_port_${channelName}`);
    }
    result.containerPort = channel.containerPort;
  }
  if (channel.hostPort !== void 0) {
    if (typeof channel.hostPort !== "number" || !Number.isInteger(channel.hostPort) || channel.hostPort < 1 || channel.hostPort > 65535) {
      throw new Error(`invalid_channel_host_port_${channelName}`);
    }
    result.hostPort = channel.hostPort;
  }
  if (channel.domains !== void 0) {
    if (!Array.isArray(channel.domains)) throw new Error(`invalid_channel_domains_${channelName}`);
    for (const d of channel.domains) {
      if (typeof d !== "string" || !d.trim()) throw new Error(`invalid_channel_domain_entry_${channelName}`);
      if (!DOMAIN_PATTERN.test(d.trim())) throw new Error(`invalid_channel_domain_format_${channelName}`);
      if (d.trim().length > 253) throw new Error(`invalid_channel_domain_length_${channelName}`);
    }
    result.domains = channel.domains.map((d) => d.trim());
  }
  if (channel.pathPrefixes !== void 0) {
    if (!Array.isArray(channel.pathPrefixes)) throw new Error(`invalid_channel_path_prefixes_${channelName}`);
    for (const p of channel.pathPrefixes) {
      if (typeof p !== "string" || !p.trim()) throw new Error(`invalid_channel_path_prefix_entry_${channelName}`);
      if (!PATH_PREFIX_PATTERN.test(p.trim())) throw new Error(`invalid_channel_path_prefix_format_${channelName}`);
    }
    result.pathPrefixes = channel.pathPrefixes.map((p) => p.trim());
  }
  if (channel.rewritePath !== void 0) {
    if (typeof channel.rewritePath !== "string" || !channel.rewritePath.trim()) throw new Error(`invalid_channel_rewrite_path_${channelName}`);
    const rewritePath = channel.rewritePath.trim();
    if (!rewritePath.startsWith("/")) throw new Error(`invalid_channel_rewrite_path_${channelName}`);
    result.rewritePath = rewritePath;
  }
  const healthcheckPath = parseOptionalString(channel.healthcheckPath, `invalid_channel_healthcheck_path_${channelName}`);
  if (healthcheckPath) result.healthcheckPath = healthcheckPath;
  if (channel.sharedSecretEnv !== void 0) {
    if (typeof channel.sharedSecretEnv !== "string" || !channel.sharedSecretEnv.trim()) throw new Error(`invalid_channel_shared_secret_env_${channelName}`);
    result.sharedSecretEnv = channel.sharedSecretEnv.trim();
  }
  const volumes = parseOptionalVolumes(channel.volumes, `invalid_channel_volumes_${channelName}`);
  if (volumes) result.volumes = volumes;
  return result;
}
function parseServiceConfig(raw, serviceName) {
  const config = assertRecord(raw ?? {}, `invalid_service_config_${serviceName}`);
  const result = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.trim()) throw new Error(`invalid_service_config_key_${serviceName}_empty`);
    if (typeof value !== "string") throw new Error(`invalid_service_config_value_${serviceName}_${key}`);
    result[key] = value.replace(/[\r\n]+/g, "").trim();
  }
  return result;
}
function parseService(raw, serviceName) {
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
  const result = {
    enabled,
    image: image.trim(),
    containerPort,
    config: parseServiceConfig(service.config, serviceName)
  };
  const template = parseOptionalString(service.template, `service_template_${serviceName}`);
  if (template) result.template = template;
  if (service.supportsMultipleInstances !== void 0) {
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
  if (service.dependsOn !== void 0) {
    if (!Array.isArray(service.dependsOn)) throw new Error(`invalid_service_depends_on_${serviceName}`);
    for (const dep of service.dependsOn) {
      if (typeof dep !== "string" || !dep.trim()) throw new Error(`invalid_service_depends_on_entry_${serviceName}`);
    }
    result.dependsOn = service.dependsOn.map((d) => d.trim());
  }
  return result;
}
function parseServices(raw) {
  if (raw === void 0) return {};
  const doc = assertRecord(raw, "invalid_services");
  const services = {};
  for (const [name, value] of Object.entries(doc)) {
    if (!name.trim()) throw new Error(`invalid_service_name_${name}`);
    services[name] = parseService(value, name);
  }
  return services;
}
function parseCaddyConfig(raw) {
  if (raw === void 0) return void 0;
  const doc = assertRecord(raw, "invalid_caddy_config");
  const caddy = {};
  if (doc.email !== void 0) {
    if (typeof doc.email !== "string") throw new Error("invalid_caddy_email");
    if (!EMAIL_PATTERN.test(doc.email.trim())) throw new Error("invalid_caddy_email_format");
    caddy.email = doc.email.trim();
  }
  return caddy;
}
function parseAutomations(raw) {
  if (raw === void 0) return defaultAutomations();
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
    const result = { id, name, schedule, script, enabled };
    const description = parseOptionalString(automation.description, `automation_description_${index}`);
    if (description) result.description = description;
    if (automation.core === true) result.core = true;
    return result;
  });
}
function parseStackSpec(raw) {
  const doc = assertRecord(raw, "invalid_stack_spec");
  const allowedKeys = /* @__PURE__ */ new Set(["version", "accessScope", "ingressPort", "caddy", "channels", "services", "automations"]);
  for (const key of Object.keys(doc)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown_stack_spec_field_${key}`);
  }
  const version = doc.version;
  if (version !== 3) throw new Error("invalid_stack_spec_version");
  if (doc.accessScope !== "host" && doc.accessScope !== "lan" && doc.accessScope !== "public") throw new Error("invalid_access_scope");
  let ingressPort;
  if (doc.ingressPort !== void 0) {
    if (typeof doc.ingressPort !== "number" || !Number.isInteger(doc.ingressPort) || doc.ingressPort < 1 || doc.ingressPort > 65535) {
      throw new Error("invalid_ingress_port");
    }
    ingressPort = doc.ingressPort;
  }
  const caddy = parseCaddyConfig(doc.caddy);
  const channelsDoc = assertRecord(doc.channels, "missing_channels");
  const channels = {};
  for (const [name, value] of Object.entries(channelsDoc)) {
    if (!name.trim()) throw new Error(`invalid_channel_name_${name}`);
    channels[name] = parseChannel(value, name);
  }
  const services = parseServices(doc.services);
  const automations = parseAutomations(doc.automations);
  const result = {
    version: StackSpecVersion,
    accessScope: doc.accessScope,
    channels,
    services,
    automations
  };
  if (ingressPort !== void 0) result.ingressPort = ingressPort;
  if (caddy) result.caddy = caddy;
  return result;
}
function stringifyStackSpec(spec) {
  return `${stringifyYamlDocument(spec)}
`;
}
function ensureStackSpec(path) {
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    return parseStackSpec(parseYamlDocument(content));
  }
  const initial = createDefaultStackSpec();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyStackSpec(initial), "utf8");
  return initial;
}
function parseSecretReference(value) {
  const match = value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
  if (!match) return null;
  return match[1];
}
export {
  BuiltInChannelPorts as B,
  parseSecretReference as a,
  createLogger as c,
  ensureStackSpec as e,
  getBuiltInChannelDef as g,
  isBuiltInChannel as i,
  parseStackSpec as p,
  stringifyStackSpec as s
};
