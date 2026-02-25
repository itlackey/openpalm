import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_CHANNELS } from "../../assets/channels/index.ts";
import { generateStackArtifacts } from "./stack-generator.ts";
import { composeServiceName } from "./service-name.ts";

import { ensureStackSpec, isBuiltInChannel, parseSecretReference, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import { validateCron } from "./cron.ts";
import type { ChannelExposure, StackAutomation, StackSpec } from "./stack-spec.ts";
import type { EnvVarDef, ResolvedSnippet } from "../shared/snippet-types.ts";

export type ChannelName = string;
export type StackCatalogItemType = "channel" | "service";

export type StackCatalogField = {
  key: string;
  required: boolean;
  description?: string;
  defaultValue?: string;
};

export type StackCatalogItem = {
  id: string;
  type: StackCatalogItemType;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  enabled: boolean;
  installed: boolean;
  entryKind: "installed" | "template";
  templateName?: string;
  supportsMultipleInstances?: boolean;
  exposure?: ChannelExposure;
  config: Record<string, string>;
  fields: StackCatalogField[];
  image?: string;
  containerPort?: number;
  rewritePath?: string;
  sharedSecretEnv?: string;
  volumes?: string[];
  dependsOn?: string[];
};

export type StackManagerPaths = {
  stateRootPath: string;
  /** Host path mounted at /data inside the admin container. Written to runtimeEnvPath as OPENPALM_STATE_HOME for compose interpolation. */
  dataRootPath: string;
  /** Host path mounted at /config inside the admin container. Written to runtimeEnvPath as OPENPALM_CONFIG_HOME for compose interpolation. */
  configRootPath: string;
  caddyJsonPath: string;
  composeFilePath: string;
  /** Runtime env file at $STATE/.env — contains host-side paths and generated secrets (POSTGRES_PASSWORD etc.) used by docker compose interpolation. */
  runtimeEnvPath: string;
  systemEnvPath: string;
  secretsEnvPath: string;
  stackSpecPath: string;
  gatewayEnvPath: string;
  openmemoryEnvPath: string;
  postgresEnvPath: string;
  qdrantEnvPath: string;
  assistantEnvPath: string;
  dataEnvPath?: string;
  renderReportPath?: string;
};

export const CoreSecretRequirements = [
  { service: "admin", key: "ADMIN_TOKEN", required: true },
  { service: "postgres", key: "POSTGRES_PASSWORD", required: true },
] as const;


function nextInstanceName(baseName: string, used: Set<string>): string {
  if (!used.has(baseName)) return baseName;
  let idx = 2;
  while (used.has(`${baseName}-${idx}`)) idx += 1;
  return `${baseName}-${idx}`;
}

function pickEnv(source: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value) out[key] = value;
  }
  return out;
}

export class StackManager {
  private cachedSpec: StackSpec | null = null;
  private artifactContentCache = new Map<string, string>();
  private runtimeEnvCache: string | null = null;
  private secretsFileMtimeMs: number | null = null;
  private dataEnvFileMtimeMs: number | null = null;
  private cachedSecrets: Record<string, string> | null = null;

  constructor(private readonly paths: StackManagerPaths) {}

  getPaths(): StackManagerPaths {
    return { ...this.paths };
  }

  getSpec(): StackSpec {
    if (!this.cachedSpec) {
      this.cachedSpec = ensureStackSpec(this.paths.stackSpecPath);
    }
    return structuredClone(this.cachedSpec);
  }

  setSpec(raw: unknown): StackSpec {
    const spec = parseStackSpec(raw);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    this.renderArtifacts();
    return spec;
  }

  getChannelAccess(channel: ChannelName): ChannelExposure {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    return spec.channels[channel].exposure;
  }

  getChannelConfig(channel: ChannelName): Record<string, string> {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    return { ...spec.channels[channel].config };
  }

  setChannelAccess(channel: ChannelName, access: ChannelExposure) {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    spec.channels[channel].enabled = true;
    spec.channels[channel].exposure = access;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }

  setChannelConfig(channel: ChannelName, values: Record<string, string>) {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    const current = spec.channels[channel].config;
    if (isBuiltInChannel(channel)) {
      const next: Record<string, string> = {};
      for (const key of Object.keys(current)) {
        next[key] = sanitizeEnvScalar(values[key] ?? "");
      }
      spec.channels[channel].config = next;
    } else {
      const next: Record<string, string> = {};
      for (const key of Object.keys(values)) {
        next[key] = sanitizeEnvScalar(values[key] ?? "");
      }
      spec.channels[channel].config = next;
    }
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }

  getServiceConfig(service: string): Record<string, string> {
    const spec = this.getSpec();
    if (!spec.services[service]) throw new Error(`unknown_service_${service}`);
    return { ...spec.services[service].config };
  }

  setServiceConfig(service: string, values: Record<string, string>) {
    const spec = this.getSpec();
    if (!spec.services[service]) throw new Error(`unknown_service_${service}`);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!key.trim()) continue;
      next[key] = sanitizeEnvScalar(value ?? "");
    }
    spec.services[service].enabled = true;
    spec.services[service].config = next;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }

  listStackCatalogItems(snippets: ResolvedSnippet[] = []): StackCatalogItem[] {
    const spec = this.getSpec();
    const items: StackCatalogItem[] = [];
    const installedTemplates = new Set<string>();
    for (const [name, channel] of Object.entries(spec.channels)) {
      const templateName = channel.template ?? (isBuiltInChannel(name) ? name : name);
      if (channel.enabled) installedTemplates.add(`channel:${templateName}`);
      const builtIn = BUILTIN_CHANNELS[templateName];
      const envDefs: EnvVarDef[] = builtIn
        ? builtIn.env
        : Object.keys(channel.config).map((key) => ({ name: key, required: false }));
      items.push({
        id: `installed:channel:${name}`,
        type: "channel",
        name,
        displayName: builtIn?.name ?? channel.name ?? name,
        description: builtIn?.description ?? channel.description ?? "",
        tags: ["channel", builtIn ? "built-in" : "custom"],
        enabled: channel.enabled,
        installed: true,
        entryKind: "installed",
        templateName,
        supportsMultipleInstances: channel.supportsMultipleInstances === true,
        exposure: channel.exposure,
        config: { ...channel.config },
        fields: envDefs.map((field) => ({ key: field.name, required: field.required, description: field.description, defaultValue: field.default })),
        image: channel.image,
        containerPort: channel.containerPort,
        rewritePath: channel.rewritePath,
        sharedSecretEnv: channel.sharedSecretEnv,
        volumes: channel.volumes,
      });
    }
    for (const [name, service] of Object.entries(spec.services)) {
      const templateName = service.template ?? name;
      if (service.enabled) installedTemplates.add(`service:${templateName}`);
      items.push({
        id: `installed:service:${name}`,
        type: "service",
        name,
        displayName: service.name ?? name,
        description: service.description ?? "",
        tags: ["service", "custom"],
        enabled: service.enabled,
        installed: true,
        entryKind: "installed",
        templateName,
        supportsMultipleInstances: service.supportsMultipleInstances === true,
        config: { ...service.config },
        fields: Object.keys(service.config).map((key) => ({ key, required: false })),
        image: service.image,
        containerPort: service.containerPort,
        volumes: service.volumes,
        dependsOn: service.dependsOn,
      });
    }

    for (const [name, def] of Object.entries(BUILTIN_CHANNELS)) {
      const templateKey = `channel:${name}`;
      if (installedTemplates.has(templateKey)) continue;
      items.push({
        id: `template:channel:${name}`,
        type: "channel",
        name,
        displayName: def.name,
        description: def.description ?? "",
        tags: ["channel", "template", "built-in"],
        enabled: false,
        installed: false,
        entryKind: "template",
        templateName: name,
        supportsMultipleInstances: false,
        exposure: "lan",
        config: Object.fromEntries(def.env.map((field) => [field.name, field.default ?? ""])),
        fields: def.env.map((field) => ({ key: field.name, required: field.required, description: field.description, defaultValue: field.default })),
        containerPort: def.containerPort,
        rewritePath: def.rewritePath,
        sharedSecretEnv: def.sharedSecretEnv,
      });
    }

    for (const snippet of snippets) {
      if (snippet.kind !== "channel" && snippet.kind !== "service") continue;
      const type = snippet.kind;
      const templateName = sanitizeEnvScalar(snippet.name);
      if (!templateName) continue;
      const templateKey = `${type}:${templateName}`;
      const supportsMultipleInstances = snippet.supportsMultipleInstances === true;
      if (installedTemplates.has(templateKey) && !supportsMultipleInstances) continue;
      items.push({
        id: `template:${type}:${templateName}`,
        type,
        name: templateName,
        displayName: snippet.name,
        description: snippet.description ?? "",
        tags: [type, "template", snippet.trust, snippet.sourceName],
        enabled: false,
        installed: false,
        entryKind: "template",
        templateName,
        supportsMultipleInstances,
        exposure: type === "channel" ? "lan" : undefined,
        config: Object.fromEntries(snippet.env.map((field) => [field.name, field.default ?? ""])),
        fields: snippet.env.map((field) => ({ key: field.name, required: field.required, description: field.description, defaultValue: field.default })),
        image: snippet.image,
        containerPort: snippet.containerPort,
        rewritePath: snippet.rewritePath,
        sharedSecretEnv: snippet.sharedSecretEnv,
        volumes: snippet.volumes,
        dependsOn: snippet.dependsOn,
      });
    }
    return items.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      if (a.entryKind !== b.entryKind) return a.entryKind.localeCompare(b.entryKind);
      return a.displayName.localeCompare(b.displayName);
    });
  }

  mutateStackCatalogItem(input: {
    action: "install" | "uninstall" | "configure" | "add_instance";
    type: StackCatalogItemType;
    name: string;
    exposure?: unknown;
    config?: unknown;
    templateName?: unknown;
    supportsMultipleInstances?: unknown;
    image?: unknown;
    containerPort?: unknown;
    rewritePath?: unknown;
    sharedSecretEnv?: unknown;
    volumes?: unknown;
    dependsOn?: unknown;
    fields?: unknown;
    displayName?: unknown;
    description?: unknown;
    tags?: unknown;
  }): StackCatalogItem {
    const action = input.action;
    const type = input.type;
    const name = sanitizeEnvScalar(input.name);
    if (!name) throw new Error("invalid_catalog_item_name");
    const spec = this.getSpec();
    if (action === "add_instance") {
      const templateName = sanitizeEnvScalar(input.templateName ?? name);
      if (!templateName) throw new Error("invalid_catalog_template_name");
      const supportsMultipleInstances = input.supportsMultipleInstances === true;
      const fields = Array.isArray(input.fields) ? input.fields : [];
      const defaults = Object.fromEntries(fields
        .filter((field) => typeof field === "object" && field !== null && typeof (field as { key?: unknown }).key === "string")
        .map((field) => {
          const value = field as { key: string; defaultValue?: unknown };
          const fallback = typeof value.defaultValue === "string" ? sanitizeEnvScalar(value.defaultValue) : "";
          return [sanitizeEnvScalar(value.key), fallback];
        })
        .filter(([key]) => key.length > 0));
      const displayName = sanitizeEnvScalar(input.displayName) || templateName;
      const description = sanitizeEnvScalar(input.description);
      const image = sanitizeEnvScalar(input.image);
      const containerPort = typeof input.containerPort === "number" && Number.isInteger(input.containerPort) ? input.containerPort : undefined;
      const volumes = Array.isArray(input.volumes) ? input.volumes.filter((v): v is string => typeof v === "string").map((v) => sanitizeEnvScalar(v)).filter((v) => v.length > 0) : undefined;
      const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.filter((v): v is string => typeof v === "string").map((v) => sanitizeEnvScalar(v)).filter((v) => v.length > 0) : undefined;
      let instanceName = "";
      if (type === "channel") {
        const used = new Set(Object.keys(spec.channels));
        const baseName = composeServiceName(templateName || name);
        if (!baseName) throw new Error("invalid_catalog_channel_base_name");
        if (!supportsMultipleInstances && spec.channels[baseName]) {
          throw new Error(`multiple_instances_not_supported_for_channel_template_${templateName}`);
        }
        instanceName = nextInstanceName(baseName, used);
        const channel: StackSpec["channels"][string] = {
          enabled: true,
          exposure: "lan",
          template: templateName,
          supportsMultipleInstances,
          name: displayName,
          description: description || undefined,
          image: image || undefined,
          containerPort,
          rewritePath: typeof input.rewritePath === "string" ? sanitizeEnvScalar(input.rewritePath) : undefined,
          sharedSecretEnv: typeof input.sharedSecretEnv === "string" ? sanitizeEnvScalar(input.sharedSecretEnv) : undefined,
          volumes,
          config: defaults,
        };
        spec.channels[instanceName] = channel;
      } else {
        const used = new Set(Object.keys(spec.services));
        const baseName = composeServiceName(templateName || name);
        if (!baseName) throw new Error("invalid_catalog_service_base_name");
        if (!supportsMultipleInstances && spec.services[baseName]) {
          throw new Error(`multiple_instances_not_supported_for_service_template_${templateName}`);
        }
        instanceName = nextInstanceName(baseName, used);
        if (!image) throw new Error("missing_service_image_for_catalog_instance");
        if (!containerPort) throw new Error("missing_service_port_for_catalog_instance");
        spec.services[instanceName] = {
          enabled: true,
          template: templateName,
          supportsMultipleInstances,
          name: displayName,
          description: description || undefined,
          image,
          containerPort,
          volumes,
          dependsOn,
          config: defaults,
        };
      }
      const validated = parseStackSpec(spec);
      this.writeStackSpecAtomically(stringifyStackSpec(validated));
      this.cachedSpec = validated;
      this.renderArtifacts();
      const updated = this.listStackCatalogItems().find((item) =>
        item.type === type
        && item.entryKind === "installed"
        && item.name === instanceName
      );
      if (!updated) throw new Error(`catalog_item_not_found_after_add_instance_${type}_${templateName}`);
      return updated;
    }
    if (type === "channel") {
      const channel = spec.channels[name];
      if (!channel) throw new Error(`unknown_channel_${name}`);
      if (action === "install") {
        channel.enabled = true;
      } else if (action === "uninstall") {
        channel.enabled = false;
      } else {
        if (input.exposure === "host" || input.exposure === "lan" || input.exposure === "public") {
          channel.exposure = input.exposure;
        }
        if (input.config && typeof input.config === "object" && !Array.isArray(input.config)) {
          const next: Record<string, string> = {};
          const current = channel.config;
          if (isBuiltInChannel(name)) {
            for (const key of Object.keys(current)) {
              const value = (input.config as Record<string, unknown>)[key];
              next[key] = typeof value === "string" ? sanitizeEnvScalar(value) : "";
            }
          } else {
            for (const [key, value] of Object.entries(input.config as Record<string, unknown>)) {
              if (!key.trim() || typeof value !== "string") continue;
              next[key] = sanitizeEnvScalar(value);
            }
          }
          channel.config = next;
        }
        channel.enabled = true;
      }
    } else {
      const service = spec.services[name];
      if (!service) throw new Error(`unknown_service_${name}`);
      if (action === "install") {
        service.enabled = true;
      } else if (action === "uninstall") {
        service.enabled = false;
      } else {
        if (input.config && typeof input.config === "object" && !Array.isArray(input.config)) {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(input.config as Record<string, unknown>)) {
            if (!key.trim() || typeof value !== "string") continue;
            next[key] = sanitizeEnvScalar(value);
          }
          service.config = next;
        }
        service.enabled = true;
      }
    }
    const validated = parseStackSpec(spec);
    this.writeStackSpecAtomically(stringifyStackSpec(validated));
    this.cachedSpec = validated;
    this.renderArtifacts();
    const updated = this.listStackCatalogItems().find((item) => item.type === type && item.name === name && item.entryKind === "installed");
    if (!updated) throw new Error(`catalog_item_not_found_after_mutation_${type}_${name}`);
    return updated;
  }

  setAccessScope(scope: "host" | "lan" | "public") {
    const spec = this.getSpec();
    spec.accessScope = scope;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }

  renderPreview() {
    return generateStackArtifacts(this.getSpec(), this.readSecretsEnv());
  }

  renderArtifacts(precomputed?: ReturnType<StackManager["renderPreview"]>) {
    const generated = precomputed ?? this.renderPreview();
    const changedArtifacts: string[] = [];
    const write = (path: string, content: string) => this.writeArtifact(path, content, changedArtifacts);

    write(this.paths.caddyJsonPath, generated.caddyJson);
    write(this.paths.composeFilePath, generated.composeFile);
    write(this.paths.systemEnvPath, generated.systemEnv);
    write(this.paths.gatewayEnvPath, generated.gatewayEnv);
    write(this.paths.openmemoryEnvPath, generated.openmemoryEnv);
    write(this.paths.postgresEnvPath, generated.postgresEnv);
    write(this.paths.qdrantEnvPath, generated.qdrantEnv);
    write(this.paths.assistantEnvPath, generated.assistantEnv);
    for (const [serviceName, content] of Object.entries(generated.channelEnvs)) {
      write(join(this.paths.stateRootPath, serviceName, ".env"), content);
    }
    for (const [serviceName, content] of Object.entries(generated.serviceEnvs)) {
      write(join(this.paths.stateRootPath, serviceName, ".env"), content);
    }

    // Write host-side path vars and compose-interpolation secrets into runtimeEnvPath ($STATE/.env).
    // These are needed by `docker compose --env-file` to interpolate ${OPENPALM_STATE_HOME},
    // ${OPENPALM_DATA_HOME}, ${OPENPALM_CONFIG_HOME}, and ${POSTGRES_PASSWORD} in the generated
    // docker-compose.yml. They are not available inside the admin container process environment.
    const secrets = this.readSecretsEnv();
    const runtimeEnvEntries: Record<string, string | undefined> = {
      OPENPALM_STATE_HOME: this.paths.stateRootPath,
      OPENPALM_DATA_HOME: this.paths.dataRootPath,
      OPENPALM_CONFIG_HOME: this.paths.configRootPath,
      POSTGRES_PASSWORD: secrets["POSTGRES_PASSWORD"],
    };
    if (this.runtimeEnvCache === null) {
      this.runtimeEnvCache = existsSync(this.paths.runtimeEnvPath)
        ? readFileSync(this.paths.runtimeEnvPath, "utf8")
        : "";
    }
    const existingRuntime = this.runtimeEnvCache;
    const updatedRuntime = updateRuntimeEnvContent(existingRuntime, runtimeEnvEntries);
    mkdirSync(dirname(this.paths.runtimeEnvPath), { recursive: true });
    writeFileSync(this.paths.runtimeEnvPath, updatedRuntime, "utf8");
    this.runtimeEnvCache = updatedRuntime;

    const renderReportPath = this.paths.renderReportPath ?? join(this.paths.stateRootPath, "render-report.json");
    const renderReport = {
      ...generated.renderReport,
      changedArtifacts,
      applySafe: generated.renderReport.missingSecretReferences.length === 0,
    };

    mkdirSync(dirname(renderReportPath), { recursive: true });
    writeFileSync(renderReportPath, `${JSON.stringify(renderReport, null, 2)}\n`, "utf8");

    return { ...generated, renderReport };
  }

  validateReferencedSecrets(specOverride?: StackSpec) {
    const spec = specOverride ?? this.getSpec();
    const availableSecrets = this.readSecretsEnv();
    const errors: string[] = [];
    for (const [channel, cfg] of Object.entries(spec.channels)) {
      if (!cfg.enabled) continue;
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        if (!availableSecrets[ref]) errors.push(`missing_secret_reference_${channel}_${key}_${ref}`);
      }
    }
    for (const [service, cfg] of Object.entries(spec.services)) {
      if (!cfg.enabled) continue;
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        if (!availableSecrets[ref]) errors.push(`missing_secret_reference_${service}_${key}_${ref}`);
      }
    }
    return errors;
  }

  listSecretManagerState() {
    const spec = this.getSpec();
    const secretValues = this.readSecretsEnv();
    const usedBy = new Map<string, string[]>();

    for (const item of CoreSecretRequirements) {
      const list = usedBy.get(item.key) ?? [];
      list.push(`core:${item.service}`);
      usedBy.set(item.key, list);
    }

    for (const [channel, cfg] of Object.entries(spec.channels)) {
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        const list = usedBy.get(ref) ?? [];
        list.push(`channel:${channel}:${key}`);
        usedBy.set(ref, list);
      }
    }

    for (const [service, cfg] of Object.entries(spec.services)) {
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        const list = usedBy.get(ref) ?? [];
        list.push(`service:${service}:${key}`);
        usedBy.set(ref, list);
      }
    }

    const uniqueNames = Array.from(new Set([
      ...Object.keys(secretValues),
      ...Array.from(usedBy.keys()),
      ...CoreSecretRequirements.map((item) => item.key),
    ])).sort();

    return {
      available: uniqueNames,
      requiredCore: CoreSecretRequirements,
      secrets: uniqueNames.map((name) => ({
        name,
        configured: Boolean(secretValues[name]),
        usedBy: usedBy.get(name) ?? [],
      })),
    };
  }

  upsertSecret(nameRaw: unknown, valueRaw: unknown) {
    const name = sanitizeEnvScalar(nameRaw).toUpperCase();
    if (!this.isValidSecretName(name)) throw new Error("invalid_secret_name");
    const value = sanitizeEnvScalar(valueRaw);
    this.updateSecretsEnv({ [name]: value || undefined });
    this.renderArtifacts();
    return name;
  }

  deleteSecret(nameRaw: unknown) {
    const name = sanitizeEnvScalar(nameRaw).toUpperCase();
    if (!this.isValidSecretName(name)) throw new Error("invalid_secret_name");
    const usedByCore = CoreSecretRequirements.some((item) => item.key === name);
    const usedByReferences = this.listSecretManagerState().secrets.some((item) => item.name === name && item.usedBy.length > 0);
    if (usedByCore || usedByReferences) throw new Error("secret_in_use");
    this.updateSecretsEnv({ [name]: undefined });
    return name;
  }

  listAutomations() {
    return this.getSpec().automations;
  }

  getAutomation(idRaw: unknown) {
    const id = sanitizeEnvScalar(idRaw);
    if (!id) return undefined;
    return this.getSpec().automations.find((automation) => automation.id === id);
  }

  upsertAutomation(input: { id?: unknown; name?: unknown; schedule?: unknown; enabled?: unknown; script?: unknown; description?: unknown; core?: boolean }) {
    const id = sanitizeEnvScalar(input.id);
    const name = sanitizeEnvScalar(input.name);
    const schedule = sanitizeEnvScalar(input.schedule);
    const scriptRaw = typeof input.script === "string" ? input.script : "";
    const script = scriptRaw.trim();
    if (!id) throw new Error("invalid_automation_id");
    if (!name) throw new Error("invalid_automation_name");
    if (!schedule) throw new Error("invalid_automation_schedule");
    const cronError = validateCron(schedule);
    if (cronError) throw new Error("invalid_cron_schedule");
    if (!script) throw new Error("invalid_automation_script");
    if (typeof input.enabled !== "boolean") throw new Error("invalid_automation_enabled");

    const spec = this.getSpec();
    const automation: StackAutomation = { id, name, schedule, enabled: input.enabled, script };
    if (typeof input.description === "string" && input.description.trim()) automation.description = input.description.trim();
    if (input.core === true) automation.core = true;
    const index = spec.automations.findIndex((item) => item.id === id);
    if (index >= 0) spec.automations[index] = automation;
    else spec.automations.push(automation);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return automation;
  }

  deleteAutomation(idRaw: unknown) {
    const id = sanitizeEnvScalar(idRaw);
    if (!id) throw new Error("invalid_automation_id");
    const spec = this.getSpec();
    const existing = spec.automations.find((automation) => automation.id === id);
    if (!existing) return false;
    if (existing.core) throw new Error("cannot_delete_core_automation");
    spec.automations = spec.automations.filter((automation) => automation.id !== id);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return true;
  }

  /** Returns all channel names (built-in + custom) from the spec. */
  listChannelNames(): string[] {
    return Object.keys(this.getSpec().channels);
  }

  /** Returns enabled channel service names (e.g., "channel-chat", "channel-my-custom"). */
  enabledChannelServiceNames(): string[] {
    const spec = this.getSpec();
    return Object.keys(spec.channels)
      .filter((name) => spec.channels[name].enabled)
      .map((name) => `channel-${composeServiceName(name)}`);
  }

  /** Returns all service names from the spec. */
  listServiceNames(): string[] {
    return Object.keys(this.getSpec().services);
  }

  /** Returns enabled service names (e.g., "service-n8n"). */
  enabledServiceNames(): string[] {
    const spec = this.getSpec();
    return Object.keys(spec.services)
      .filter((name) => spec.services[name].enabled)
      .map((name) => `service-${composeServiceName(name)}`);
  }

  private writeArtifact(path: string, content: string, changedList: string[]): void {
    let current = this.artifactContentCache.get(path);
    if (current === undefined) {
      current = existsSync(path) ? readFileSync(path, "utf8") : "";
      this.artifactContentCache.set(path, current);
    }
    if (current !== content) changedList.push(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    this.artifactContentCache.set(path, content);
  }

  private writeStackSpecAtomically(content: string) {
    const tempPath = `${this.paths.stackSpecPath}.${randomUUID()}.tmp`;
    mkdirSync(dirname(this.paths.stackSpecPath), { recursive: true });
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, this.paths.stackSpecPath);
  }

  private readSecretsEnv() {
    const secretsMtime = existsSync(this.paths.secretsEnvPath)
      ? statSync(this.paths.secretsEnvPath).mtimeMs
      : -1;
    const dataEnvPath = this.paths.dataEnvPath;
    const dataMtime = dataEnvPath && existsSync(dataEnvPath)
      ? statSync(dataEnvPath).mtimeMs
      : -1;

    if (
      this.cachedSecrets
      && this.secretsFileMtimeMs === secretsMtime
      && this.dataEnvFileMtimeMs === dataMtime
    ) {
      return this.cachedSecrets;
    }

    const secrets = existsSync(this.paths.secretsEnvPath)
      ? parseRuntimeEnvContent(readFileSync(this.paths.secretsEnvPath, "utf8"))
      : {};

    let merged = secrets;
    if (dataEnvPath && existsSync(dataEnvPath)) {
      const dataEnv = parseRuntimeEnvContent(readFileSync(dataEnvPath, "utf8"));
      const profileEnv = pickEnv(dataEnv, ["OPENPALM_PROFILE_NAME", "OPENPALM_PROFILE_EMAIL"]);
      merged = { ...secrets, ...profileEnv };
    }

    this.secretsFileMtimeMs = secretsMtime;
    this.dataEnvFileMtimeMs = dataMtime;
    this.cachedSecrets = merged;
    return merged;
  }

  /** Returns the compose interpolation entries that must be present in runtimeEnvPath. */
  getRuntimeEnvEntries(): Record<string, string | undefined> {
    const secrets = this.readSecretsEnv();
    return {
      OPENPALM_STATE_HOME: this.paths.stateRootPath,
      OPENPALM_DATA_HOME: this.paths.dataRootPath,
      OPENPALM_CONFIG_HOME: this.paths.configRootPath,
      POSTGRES_PASSWORD: secrets["POSTGRES_PASSWORD"],
    };
  }

  private updateSecretsEnv(entries: Record<string, string | undefined>) {
    const current = existsSync(this.paths.secretsEnvPath) ? readFileSync(this.paths.secretsEnvPath, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    writeFileSync(this.paths.secretsEnvPath, next, "utf8");
    this.cachedSecrets = null;
    this.secretsFileMtimeMs = null;
  }

  private isValidSecretName(name: string) {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
  }
}
