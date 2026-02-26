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

function forEachSecretRef(spec: StackSpec, fn: (scope: string, name: string, key: string, ref: string) => void): void {
  for (const [name, cfg] of Object.entries(spec.channels)) {
    for (const [key, value] of Object.entries(cfg.config)) {
      const ref = parseSecretReference(value);
      if (ref) fn("channel", name, key, ref);
    }
  }
}

type ChannelName = string;

type StackManagerPaths = {
  stateRootPath: string;
  dataRootPath: string;
  configRootPath: string;
  composeFilePath: string;
  runtimeEnvPath: string;
  systemEnvPath: string;
  secretsEnvPath: string;
  stackSpecPath: string;
  dataEnvPath?: string;
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
  private runtimeEnvCache: string | null = null;
  private secretsFileMtimeMs: number | null = null;
  private dataEnvFileMtimeMs: number | null = null;
  private cachedSecrets: Record<string, string> | null = null;

  constructor(private readonly paths: StackManagerPaths) {}

  getPaths() {
    const s = this.paths.stateRootPath;
    return {
      ...this.paths,
      caddyJsonPath: join(s, "caddy.json"),
      gatewayEnvPath: join(s, "gateway", ".env"),
      openmemoryEnvPath: join(s, "openmemory", ".env"),
      postgresEnvPath: join(s, "postgres", ".env"),
      qdrantEnvPath: join(s, "qdrant", ".env"),
      assistantEnvPath: join(s, "assistant", ".env"),
    };
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
    this.writeAllArtifacts(generated);
    this.ensureRuntimeEnv();
    return generated;
  }

  validateReferencedSecrets(specOverride?: StackSpec) {
    const spec = specOverride ?? this.getSpec();
    const availableSecrets = this.readSecretsEnv();
    const errors: string[] = [];
    forEachSecretRef(spec, (_scope, name, key, ref) => {
      const cfg = spec.channels[name];
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

  listChannelNames(): string[] {
    return Object.keys(this.getSpec().channels);
  }

  private writeAllArtifacts(generated: ReturnType<StackManager["renderPreview"]>): void {
    const p = this.getPaths();
    const w = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, "utf8"); };
    w(p.caddyJsonPath, generated.caddyJson);
    w(p.composeFilePath, generated.composeFile);
    w(p.systemEnvPath, generated.systemEnv);
    w(p.gatewayEnvPath, generated.gatewayEnv);
    w(p.openmemoryEnvPath, generated.openmemoryEnv);
    w(p.postgresEnvPath, generated.postgresEnv);
    w(p.qdrantEnvPath, generated.qdrantEnv);
    w(p.assistantEnvPath, generated.assistantEnv);
    for (const [svc, content] of Object.entries(generated.channelEnvs)) w(join(p.stateRootPath, svc, ".env"), content);
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
