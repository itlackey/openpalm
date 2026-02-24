import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_CHANNELS } from "../../assets/channels/index.ts";
import { generateStackArtifacts } from "./stack-generator.ts";
import { validateFallbackBundle } from "./fallback-bundle.ts";
import { ensureStackSpec, isBuiltInChannel, parseSecretReference, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import { validateCron } from "./cron.ts";
import type { ChannelExposure, StackAutomation, StackSpec } from "./stack-spec.ts";
import type { EnvVarDef } from "../shared/snippet-types.ts";

export type ChannelName = string;
export type StackCatalogItemType = "channel" | "service";

export type StackCatalogField = {
  key: string;
  required: boolean;
  description?: string;
};

export type StackCatalogItem = {
  type: StackCatalogItemType;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  enabled: boolean;
  installed: boolean;
  exposure?: ChannelExposure;
  config: Record<string, string>;
  fields: StackCatalogField[];
};

export type StackManagerPaths = {
  stateRootPath: string;
  caddyJsonPath: string;
  composeFilePath: string;
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
  fallbackComposeFilePath?: string;
  fallbackCaddyJsonPath?: string;
  applyLockPath?: string;
};

export const CoreSecretRequirements = [
  { service: "admin", key: "ADMIN_TOKEN", required: true },
  { service: "postgres", key: "POSTGRES_PASSWORD", required: true },
] as const;


function composeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

function pickEnv(source: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value) out[key] = value;
  }
  return out;
}

function resolveEmbeddedStatePath(relativePath: string): string {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, "packages/lib/src/embedded/state", relativePath),
    join(cwd, "packages/ui", "packages/lib/src/embedded/state", relativePath),
    join(cwd, "..", "packages/lib/src/embedded/state", relativePath),
    join(cwd, "../..", "packages/lib/src/embedded/state", relativePath),
    fileURLToPath(new URL(`../embedded/state/${relativePath}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

export class StackManager {
  constructor(private readonly paths: StackManagerPaths) {}

  getPaths(): StackManagerPaths {
    return { ...this.paths };
  }

  getSpec(): StackSpec {
    return ensureStackSpec(this.paths.stackSpecPath);
  }

  setSpec(raw: unknown): StackSpec {
    const spec = parseStackSpec(raw);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
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
    return this.renderArtifacts();
  }

  listStackCatalogItems(): StackCatalogItem[] {
    const spec = this.getSpec();
    const items: StackCatalogItem[] = [];
    for (const [name, channel] of Object.entries(spec.channels)) {
      const builtIn = BUILTIN_CHANNELS[name];
      const envDefs: EnvVarDef[] = builtIn
        ? builtIn.env
        : Object.keys(channel.config).map((key) => ({ name: key, required: false }));
      items.push({
        type: "channel",
        name,
        displayName: builtIn?.name ?? channel.name ?? name,
        description: builtIn?.description ?? channel.description ?? "",
        tags: ["channel", builtIn ? "built-in" : "custom"],
        enabled: channel.enabled,
        installed: true,
        exposure: channel.exposure,
        config: { ...channel.config },
        fields: envDefs.map((field) => ({ key: field.name, required: field.required, description: field.description })),
      });
    }
    for (const [name, service] of Object.entries(spec.services)) {
      items.push({
        type: "service",
        name,
        displayName: service.name ?? name,
        description: service.description ?? "",
        tags: ["service", "custom"],
        enabled: service.enabled,
        installed: true,
        config: { ...service.config },
        fields: Object.keys(service.config).map((key) => ({ key, required: false })),
      });
    }
    return items.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.name.localeCompare(b.name);
    });
  }

  mutateStackCatalogItem(input: {
    action: "install" | "uninstall" | "configure";
    type: StackCatalogItemType;
    name: string;
    exposure?: unknown;
    config?: unknown;
  }): StackCatalogItem {
    const action = input.action;
    const type = input.type;
    const name = sanitizeEnvScalar(input.name);
    if (!name) throw new Error("invalid_catalog_item_name");
    const spec = this.getSpec();
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
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.renderArtifacts();
    const updated = this.listStackCatalogItems().find((item) => item.type === type && item.name === name);
    if (!updated) throw new Error("catalog_item_not_found_after_update");
    return updated;
  }

  setAccessScope(scope: "host" | "lan" | "public") {
    const spec = this.getSpec();
    spec.accessScope = scope;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    return this.renderArtifacts();
  }

  renderPreview() {
    return generateStackArtifacts(this.getSpec(), this.readSecretsEnv());
  }

  computeDriftReport() {
    const generated = this.renderPreview();
    const expectedServices = [
      ...Object.keys(generated.channelEnvs),
      ...Object.keys(generated.serviceEnvs),
      "admin",
      "gateway",
      "assistant",
      "openmemory",
      "openmemory-ui",
      "postgres",
      "qdrant",
      "caddy",
    ];
    const envFiles = [
      this.paths.gatewayEnvPath,
      this.paths.openmemoryEnvPath,
      this.paths.postgresEnvPath,
      this.paths.qdrantEnvPath,
      this.paths.assistantEnvPath,
      ...Object.keys(generated.channelEnvs).map((name) => join(this.paths.stateRootPath, name, ".env")),
      ...Object.keys(generated.serviceEnvs).map((name) => join(this.paths.stateRootPath, name, ".env")),
    ];
    const artifactHashes = { compose: generated.composeFile, caddy: generated.caddyJson };
    const driftReportPath = join(this.paths.stateRootPath, "drift-report.json");
    return { expectedServices, envFiles, artifactHashes, driftReportPath };
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

    const renderReportPath = this.paths.renderReportPath ?? join(this.paths.stateRootPath, "render-report.json");
    const renderReport = {
      ...generated.renderReport,
      changedArtifacts,
      applySafe: generated.renderReport.missingSecretReferences.length === 0,
    };
    const fallbackComposeFilePath = this.paths.fallbackComposeFilePath ?? join(this.paths.stateRootPath, "docker-compose-fallback.yml");
    if (!existsSync(fallbackComposeFilePath)) {
      const bundledPath = resolveEmbeddedStatePath("docker-compose-fallback.yml");
      const bundled = readFileSync(bundledPath, "utf8");
      writeFileSync(fallbackComposeFilePath, bundled, "utf8");
      validateFallbackBundle({
        composePath: fallbackComposeFilePath,
        caddyPath: this.paths.fallbackCaddyJsonPath ?? join(this.paths.stateRootPath, "caddy-fallback.json"),
      });
    }

    const fallbackCaddyJsonPath = this.paths.fallbackCaddyJsonPath ?? join(this.paths.stateRootPath, "caddy-fallback.json");
    if (!existsSync(fallbackCaddyJsonPath)) {
      const bundledPath = resolveEmbeddedStatePath("caddy/fallback-caddy.json");
      const bundled = readFileSync(bundledPath, "utf8");
      writeFileSync(fallbackCaddyJsonPath, bundled, "utf8");
      validateFallbackBundle({
        composePath: fallbackComposeFilePath,
        caddyPath: fallbackCaddyJsonPath,
      });
    }

    mkdirSync(dirname(renderReportPath), { recursive: true });
    writeFileSync(renderReportPath, `${JSON.stringify(renderReport, null, 2)}\n`, "utf8");

    return { ...generated, renderReport };
  }

  renderArtifactsToTemp(
    precomputed?: ReturnType<StackManager["renderPreview"]>,
    options?: { suffix?: string; transactionId?: string },
  ) {
    const generated = precomputed ?? this.renderPreview();
    const suffix = options?.suffix ?? ".next";
    const changedArtifacts: string[] = [];
    const staged: Array<{ tempPath: string; livePath: string }> = [];
    const backups: Array<{ prevPath: string; livePath: string }> = [];
    const stage = (livePath: string, content: string) => {
      if (!existsSync(livePath) || readFileSync(livePath, "utf8") !== content) changedArtifacts.push(livePath);
      const tempPath = `${livePath}${suffix}`;
      mkdirSync(dirname(tempPath), { recursive: true });
      writeFileSync(tempPath, content, "utf8");
      staged.push({ tempPath, livePath });
      return tempPath;
    };

    stage(this.paths.caddyJsonPath, generated.caddyJson);
    const tempComposeFilePath = stage(this.paths.composeFilePath, generated.composeFile);
    stage(this.paths.systemEnvPath, generated.systemEnv);
    stage(this.paths.gatewayEnvPath, generated.gatewayEnv);
    stage(this.paths.openmemoryEnvPath, generated.openmemoryEnv);
    stage(this.paths.postgresEnvPath, generated.postgresEnv);
    stage(this.paths.qdrantEnvPath, generated.qdrantEnv);
    stage(this.paths.assistantEnvPath, generated.assistantEnv);
    for (const [serviceName, content] of Object.entries(generated.channelEnvs)) {
      stage(join(this.paths.stateRootPath, serviceName, ".env"), content);
    }
    for (const [serviceName, content] of Object.entries(generated.serviceEnvs)) {
      stage(join(this.paths.stateRootPath, serviceName, ".env"), content);
    }

    const renderReportPath = this.paths.renderReportPath ?? join(this.paths.stateRootPath, "render-report.json");
    const renderReport = {
      ...generated.renderReport,
      changedArtifacts,
      applySafe: generated.renderReport.missingSecretReferences.length === 0,
      transactionId: options?.transactionId,
    };

    const fallbackComposeFilePath = this.paths.fallbackComposeFilePath ?? join(this.paths.stateRootPath, "docker-compose-fallback.yml");
    if (!existsSync(fallbackComposeFilePath)) {
      stage(fallbackComposeFilePath, this.buildFallbackCompose());
    }

    const fallbackCaddyJsonPath = this.paths.fallbackCaddyJsonPath ?? join(this.paths.stateRootPath, "caddy-fallback.json");
    if (!existsSync(fallbackCaddyJsonPath)) {
      stage(fallbackCaddyJsonPath, this.buildFallbackCaddyJson());
    }

    stage(renderReportPath, `${JSON.stringify(renderReport, null, 2)}\n`);

    return {
      ...generated,
      renderReport,
      composeFilePath: tempComposeFilePath,
      promote: () => {
        for (const entry of staged) {
          if (existsSync(entry.livePath)) {
            const prevPath = `${entry.livePath}.prev`;
            renameSync(entry.livePath, prevPath);
            backups.push({ prevPath, livePath: entry.livePath });
          }
          renameSync(entry.tempPath, entry.livePath);
        }
      },
      cleanup: () => {
        for (const entry of staged) {
          if (existsSync(entry.tempPath)) rmSync(entry.tempPath, { force: true });
        }
      },
      cleanupBackups: () => {
        for (const entry of backups) {
          if (existsSync(entry.prevPath)) rmSync(entry.prevPath, { force: true });
        }
      },
    };
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
        purpose: name.includes("TOKEN") || name.includes("KEY") || name.includes("SECRET") ? "credential_or_shared_secret" : "runtime_config",
        constraints: name.includes("SECRET") ? { min_length: 32 } : undefined,
        rotation: {
          recommendedDays: 90,
          lastRotated: null,
        },
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
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) changedList.push(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  private writeStackSpecAtomically(content: string) {
    const tempPath = `${this.paths.stackSpecPath}.${randomUUID()}.tmp`;
    mkdirSync(dirname(this.paths.stackSpecPath), { recursive: true });
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, this.paths.stackSpecPath);
  }

  private readSecretsEnv() {
    const secrets = existsSync(this.paths.secretsEnvPath)
      ? parseRuntimeEnvContent(readFileSync(this.paths.secretsEnvPath, "utf8"))
      : {};
    const dataEnvPath = this.paths.dataEnvPath;
    if (!dataEnvPath || !existsSync(dataEnvPath)) return secrets;
    const dataEnv = parseRuntimeEnvContent(readFileSync(dataEnvPath, "utf8"));
    const profileEnv = pickEnv(dataEnv, ["OPENPALM_PROFILE_NAME", "OPENPALM_PROFILE_EMAIL"]);
    return { ...secrets, ...profileEnv };
  }

  private updateSecretsEnv(entries: Record<string, string | undefined>) {
    const current = existsSync(this.paths.secretsEnvPath) ? readFileSync(this.paths.secretsEnvPath, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    writeFileSync(this.paths.secretsEnvPath, next, "utf8");
  }

  private isValidSecretName(name: string) {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
  }


  private buildFallbackCaddyJson(): string {
    return readFileSync(join(process.cwd(), "packages/lib/src/embedded/state/caddy/fallback-caddy.json"), "utf8");
  }
  private buildFallbackCompose(): string {
    return readFileSync(join(process.cwd(), "packages/lib/src/embedded/state/docker-compose-fallback.yml"), "utf8");
  }
}
