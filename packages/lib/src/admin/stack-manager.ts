import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { BUILTIN_CHANNELS } from "../../assets/channels/index.ts";
import { generateStackArtifacts } from "./stack-generator.ts";
import { composeServiceName } from "./service-name.ts";

import { ensureStackSpec, isBuiltInChannel, parseSecretReference, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import type { ChannelExposure, StackSpec } from "./stack-spec.ts";

export type ChannelName = string;

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
