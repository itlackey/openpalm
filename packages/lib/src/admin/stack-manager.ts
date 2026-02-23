import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { generateStackArtifacts } from "./stack-generator.ts";
import { ensureStackSpec, isBuiltInChannel, parseSecretReference, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import { validateCron } from "./cron.ts";
import type { ChannelExposure, StackAutomation, StackSpec } from "./stack-spec.ts";

export type ChannelName = string;

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
  renderReportPath?: string;
};

export const CoreSecretRequirements = [
  { service: "admin", key: "ADMIN_TOKEN", required: true },
  { service: "postgres", key: "POSTGRES_PASSWORD", required: true },
] as const;


function composeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
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

  setAccessScope(scope: "host" | "lan" | "public") {
    const spec = this.getSpec();
    spec.accessScope = scope;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
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

    const renderReportPath = this.paths.renderReportPath ?? join(this.paths.stateRootPath, "rendered", "render-report.json");
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
    if (!existsSync(this.paths.secretsEnvPath)) return {};
    return parseRuntimeEnvContent(readFileSync(this.paths.secretsEnvPath, "utf8"));
  }

  private updateSecretsEnv(entries: Record<string, string | undefined>) {
    const current = existsSync(this.paths.secretsEnvPath) ? readFileSync(this.paths.secretsEnvPath, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    writeFileSync(this.paths.secretsEnvPath, next, "utf8");
  }

  private isValidSecretName(name: string) {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
  }
}
