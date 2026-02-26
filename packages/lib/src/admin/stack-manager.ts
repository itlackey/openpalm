import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { generateStackArtifacts } from "./stack-generator.ts";

import { ensureStackSpec, parseSecretReference, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import { parseEnvContent } from "../shared/env-parser.ts";
import type { ChannelExposure, StackSpec } from "./stack-spec.ts";

function fileMtime(path: string): number {
  return existsSync(path) ? statSync(path).mtimeMs : -1;
}

function readEnvIfExists(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvContent(readFileSync(path, "utf8")) : {};
}

/** Iterate all secret references across channels and services in a spec. */
function forEachSecretRef(spec: StackSpec, fn: (scope: string, name: string, key: string, ref: string) => void): void {
  for (const [name, cfg] of Object.entries(spec.channels)) {
    for (const [key, value] of Object.entries(cfg.config)) {
      const ref = parseSecretReference(value);
      if (ref) fn("channel", name, key, ref);
    }
  }
  for (const [name, cfg] of Object.entries(spec.services)) {
    for (const [key, value] of Object.entries(cfg.config)) {
      const ref = parseSecretReference(value);
      if (ref) fn("service", name, key, ref);
    }
  }
}

type ChannelName = string;

type StackManagerPaths = {
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

  renderPreview() {
    return generateStackArtifacts(this.getSpec(), this.readSecretsEnv());
  }

  renderArtifacts(precomputed?: ReturnType<StackManager["renderPreview"]>) {
    const generated = precomputed ?? this.renderPreview();
    const changedArtifacts = this.writeAllArtifacts(generated);
    this.ensureRuntimeEnv();

    const renderReport = {
      ...generated.renderReport,
      changedArtifacts,
      applySafe: generated.renderReport.missingSecretReferences.length === 0,
    };
    this.writeRenderReport(renderReport);
    return { ...generated, renderReport };
  }

  validateReferencedSecrets(specOverride?: StackSpec) {
    const spec = specOverride ?? this.getSpec();
    const availableSecrets = this.readSecretsEnv();
    const errors: string[] = [];
    forEachSecretRef(spec, (scope, name, key, ref) => {
      const cfg = scope === "channel" ? spec.channels[name] : spec.services[name];
      if (!cfg.enabled) return;
      if (!availableSecrets[ref]) errors.push(`missing_secret_reference_${name}_${key}_${ref}`);
    });
    return errors;
  }

  listSecretManagerState() {
    const spec = this.getSpec();
    const secretValues = this.readSecretsEnv();
    const usedBy = new Map<string, string[]>();

    const addUsage = (ref: string, label: string) => {
      const list = usedBy.get(ref) ?? [];
      list.push(label);
      usedBy.set(ref, list);
    };
    for (const item of CoreSecretRequirements) addUsage(item.key, `core:${item.service}`);
    forEachSecretRef(spec, (scope, name, key, ref) => addUsage(ref, `${scope}:${name}:${key}`));

    const uniqueNames = Array.from(new Set([
      ...Object.keys(secretValues),
      ...usedBy.keys(),
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

  /** Returns all service names from the spec. */
  listServiceNames(): string[] {
    return Object.keys(this.getSpec().services);
  }

  private writeAllArtifacts(generated: ReturnType<StackManager["renderPreview"]>): string[] {
    const changed: string[] = [];
    const write = (path: string, content: string) => this.writeArtifact(path, content, changed);
    write(this.paths.caddyJsonPath, generated.caddyJson);
    write(this.paths.composeFilePath, generated.composeFile);
    write(this.paths.systemEnvPath, generated.systemEnv);
    write(this.paths.gatewayEnvPath, generated.gatewayEnv);
    write(this.paths.openmemoryEnvPath, generated.openmemoryEnv);
    write(this.paths.postgresEnvPath, generated.postgresEnv);
    write(this.paths.qdrantEnvPath, generated.qdrantEnv);
    write(this.paths.assistantEnvPath, generated.assistantEnv);
    for (const [svc, content] of Object.entries(generated.channelEnvs)) write(join(this.paths.stateRootPath, svc, ".env"), content);
    for (const [svc, content] of Object.entries(generated.serviceEnvs)) write(join(this.paths.stateRootPath, svc, ".env"), content);
    return changed;
  }

  private ensureRuntimeEnv(): void {
    if (this.runtimeEnvCache === null) {
      this.runtimeEnvCache = existsSync(this.paths.runtimeEnvPath) ? readFileSync(this.paths.runtimeEnvPath, "utf8") : "";
    }
    const updated = updateRuntimeEnvContent(this.runtimeEnvCache, this.getRuntimeEnvEntries());
    mkdirSync(dirname(this.paths.runtimeEnvPath), { recursive: true });
    writeFileSync(this.paths.runtimeEnvPath, updated, "utf8");
    this.runtimeEnvCache = updated;
  }

  private writeRenderReport(report: Record<string, unknown>): void {
    const path = this.paths.renderReportPath ?? join(this.paths.stateRootPath, "render-report.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
    const secretsMtime = fileMtime(this.paths.secretsEnvPath);
    const dataMtime = this.paths.dataEnvPath ? fileMtime(this.paths.dataEnvPath) : -1;

    if (this.cachedSecrets && this.secretsFileMtimeMs === secretsMtime && this.dataEnvFileMtimeMs === dataMtime) {
      return this.cachedSecrets;
    }

    const secrets = readEnvIfExists(this.paths.secretsEnvPath);
    const dataEnvPath = this.paths.dataEnvPath;
    const profileEnv = dataEnvPath ? pickEnv(readEnvIfExists(dataEnvPath), ["OPENPALM_PROFILE_NAME", "OPENPALM_PROFILE_EMAIL"]) : {};

    this.secretsFileMtimeMs = secretsMtime;
    this.dataEnvFileMtimeMs = dataMtime;
    this.cachedSecrets = { ...secrets, ...profileEnv };
    return this.cachedSecrets;
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
