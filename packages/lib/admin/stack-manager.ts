import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateStackArtifacts } from "./stack-generator.ts";
import { ensureStackSpec, isBuiltInChannel, parseSecretReference, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import type { ChannelExposure, StackSpec } from "./stack-spec.ts";

export type ChannelName = string;

export type StackManagerPaths = {
  caddyfilePath: string;
  caddyRoutesDir: string;
  composeFilePath: string;
  secretsEnvPath: string;
  stackSpecPath: string;
  gatewayEnvPath: string;
  openmemoryEnvPath: string;
  postgresEnvPath: string;
  qdrantEnvPath: string;
  opencodeEnvPath: string;
  channelsEnvPath: string;
};

export const CoreSecretRequirements = [
  { service: "admin", key: "ADMIN_TOKEN", required: true },
  { service: "postgres", key: "POSTGRES_PASSWORD", required: true },
] as const;

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

  renderArtifacts() {
    const generated = this.renderPreview();
    writeFileSync(this.paths.caddyfilePath, generated.caddyfile, "utf8");
    mkdirSync(this.paths.caddyRoutesDir, { recursive: true });
    this.removeStaleRouteFiles(generated.caddyRoutes);
    for (const [routeFile, content] of Object.entries(generated.caddyRoutes)) {
      const path = join(this.paths.caddyRoutesDir, routeFile);
      mkdirSync(dirname(path), { recursive: true });
      if (routeFile === "extra-user-overrides.caddy" && existsSync(path)) continue;
      writeFileSync(path, content, "utf8");
    }

    writeFileSync(this.paths.composeFilePath, generated.composeFile, "utf8");

    mkdirSync(dirname(this.paths.gatewayEnvPath), { recursive: true });
    writeFileSync(this.paths.gatewayEnvPath, generated.gatewayEnv, "utf8");
    mkdirSync(dirname(this.paths.openmemoryEnvPath), { recursive: true });
    writeFileSync(this.paths.openmemoryEnvPath, generated.openmemoryEnv, "utf8");
    mkdirSync(dirname(this.paths.postgresEnvPath), { recursive: true });
    writeFileSync(this.paths.postgresEnvPath, generated.postgresEnv, "utf8");
    mkdirSync(dirname(this.paths.qdrantEnvPath), { recursive: true });
    writeFileSync(this.paths.qdrantEnvPath, generated.qdrantEnv, "utf8");
    mkdirSync(dirname(this.paths.opencodeEnvPath), { recursive: true });
    writeFileSync(this.paths.opencodeEnvPath, generated.opencodeEnv, "utf8");
    mkdirSync(dirname(this.paths.channelsEnvPath), { recursive: true });
    writeFileSync(this.paths.channelsEnvPath, generated.channelsEnv, "utf8");

    return generated;
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

  upsertAutomation(input: { id?: unknown; name?: unknown; schedule?: unknown; enabled?: unknown; script?: unknown }) {
    const id = sanitizeEnvScalar(input.id);
    const name = sanitizeEnvScalar(input.name);
    const schedule = sanitizeEnvScalar(input.schedule);
    const scriptRaw = typeof input.script === "string" ? input.script : "";
    const script = scriptRaw.trim();
    if (!id) throw new Error("invalid_automation_id");
    if (!name) throw new Error("invalid_automation_name");
    if (!schedule) throw new Error("invalid_automation_schedule");
    if (!script) throw new Error("invalid_automation_script");
    if (typeof input.enabled !== "boolean") throw new Error("invalid_automation_enabled");

    const spec = this.getSpec();
    const automation = { id, name, schedule, enabled: input.enabled, script };
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
    const before = spec.automations.length;
    spec.automations = spec.automations.filter((automation) => automation.id !== id);
    if (spec.automations.length === before) return false;
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
      .map((name) => `channel-${name}`);
  }

  private writeStackSpecAtomically(content: string) {
    const tempPath = `${this.paths.stackSpecPath}.${Date.now()}.tmp`;
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

  private removeStaleRouteFiles(nextRoutes: Record<string, string>) {
    const keepPaths = new Set(Object.keys(nextRoutes).map((value) => join(this.paths.caddyRoutesDir, value)));
    const walk = (dirPath: string) => {
      if (!existsSync(dirPath)) return;
      for (const entry of readdirSync(dirPath)) {
        const path = join(dirPath, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        if (keepPaths.has(path)) continue;
        if (path === join(this.paths.caddyRoutesDir, "extra-user-overrides.caddy")) continue;
        rmSync(path);
      }
    };
    walk(this.paths.caddyRoutesDir);
  }
}
