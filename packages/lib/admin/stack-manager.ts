import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateStackArtifacts } from "./stack-generator.ts";
import { channelEnvSecretVariable, ensureStackSpec, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import type { ConnectionType, StackSpec } from "./stack-spec.ts";

export type ChannelName = "chat" | "discord" | "voice" | "telegram";

const Channels: ChannelName[] = ["chat", "discord", "voice", "telegram"];
const ConnectionTypes: ConnectionType[] = ["ai_provider", "platform", "api_service"];

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

  getChannelAccess(channel: ChannelName): "lan" | "public" {
    return this.getSpec().channels[channel].exposure;
  }

  getChannelConfig(channel: ChannelName): Record<string, string> {
    return { ...this.getSpec().channels[channel].config };
  }

  setChannelAccess(channel: ChannelName, access: "lan" | "public") {
    const spec = this.getSpec();
    spec.channels[channel].enabled = true;
    spec.channels[channel].exposure = access;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    return this.renderArtifacts();
  }

  setChannelConfig(channel: ChannelName, values: Record<string, string>) {
    const spec = this.getSpec();
    const current = spec.channels[channel].config;
    const next: Record<string, string> = {};
    for (const key of Object.keys(current)) {
      next[key] = sanitizeEnvScalar(values[key] ?? "");
    }
    spec.channels[channel].config = next;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    return this.renderArtifacts();
  }

  setAccessScope(scope: "host" | "lan") {
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

  setChannelSharedSecret(channel: ChannelName, secret: string) {
    const spec = this.getSpec();
    const entries: Record<string, string | undefined> = {
      [spec.secrets.gatewayChannelSecrets[channel]]: secret || undefined,
      [spec.secrets.channelServiceSecrets[channel]]: secret || undefined,
    };
    this.updateSecretsEnv(entries);
    this.renderArtifacts();
  }

  validateEnabledChannelSecrets() {
    const spec = this.getSpec();
    const availableSecrets = this.readSecretsEnv();
    const errors: string[] = [];
    for (const channel of Channels) {
      if (!spec.channels[channel].enabled) continue;
      const gatewayKey = spec.secrets.gatewayChannelSecrets[channel];
      const channelKey = spec.secrets.channelServiceSecrets[channel];
      if (!availableSecrets[gatewayKey]) errors.push(`missing_gateway_secret_${channel}`);
      if (!availableSecrets[channelKey]) errors.push(`missing_channel_secret_${channel}`);
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

    for (const connection of spec.connections) {
      for (const secretRef of Object.values(connection.env)) {
        const list = usedBy.get(secretRef) ?? [];
        list.push(`connection:${connection.id}`);
        usedBy.set(secretRef, list);
      }
    }

    for (const channel of Channels) {
      for (const [target, key] of [["gateway", spec.secrets.gatewayChannelSecrets[channel]], ["channel", spec.secrets.channelServiceSecrets[channel]]]) {
        const list = usedBy.get(key) ?? [];
        list.push(`${target}:${channel}`);
        usedBy.set(key, list);
      }
    }

    const uniqueNames = Array.from(new Set([
      ...Object.keys(secretValues),
      ...Object.values(spec.secrets.gatewayChannelSecrets),
      ...Object.values(spec.secrets.channelServiceSecrets),
      ...spec.connections.flatMap((connection) => Object.values(connection.env)),
      ...CoreSecretRequirements.map((item) => item.key),
    ])).sort();
    return {
      available: uniqueNames,
      mappings: spec.secrets,
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
    const spec = this.getSpec();
    const usedByChannel = Channels.some((channel) => spec.secrets.gatewayChannelSecrets[channel] === name || spec.secrets.channelServiceSecrets[channel] === name);
    const usedByCore = CoreSecretRequirements.some((item) => item.key === name);
    const usedByConnection = spec.connections.some((connection) => Object.values(connection.env).includes(name));
    if (usedByChannel || usedByCore || usedByConnection) throw new Error("secret_in_use");
    this.updateSecretsEnv({ [name]: undefined });
    return name;
  }

  mapChannelSecret(channelRaw: unknown, targetRaw: unknown, secretNameRaw: unknown) {
    const channel = sanitizeEnvScalar(channelRaw) as ChannelName;
    const target = sanitizeEnvScalar(targetRaw);
    const secretName = sanitizeEnvScalar(secretNameRaw).toUpperCase();
    if (!Channels.includes(channel)) throw new Error("invalid_channel");
    if (target !== "gateway" && target !== "channel") throw new Error("invalid_target");
    if (!this.isValidSecretName(secretName)) throw new Error("invalid_secret_name");

    const spec = this.getSpec();
    const available = new Set(Object.keys(this.readSecretsEnv()));
    if (!available.has(secretName)) throw new Error("unknown_secret_name");
    if (target === "gateway") spec.secrets.gatewayChannelSecrets[channel] = secretName;
    else spec.secrets.channelServiceSecrets[channel] = secretName;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.renderArtifacts();
    return { channel, target, secretName };
  }

  getChannelSecretMappings(channel: ChannelName) {
    const spec = this.getSpec();
    return {
      gateway: spec.secrets.gatewayChannelSecrets[channel],
      channel: spec.secrets.channelServiceSecrets[channel],
      requiredEnvKey: channelEnvSecretVariable(channel),
    };
  }

  listConnections() {
    return this.getSpec().connections;
  }

  upsertConnection(input: { id?: unknown; name?: unknown; type?: unknown; env?: unknown }) {
    const id = sanitizeEnvScalar(input.id);
    const name = sanitizeEnvScalar(input.name);
    const type = sanitizeEnvScalar(input.type) as ConnectionType;
    if (!id) throw new Error("invalid_connection_id");
    if (!name) throw new Error("invalid_connection_name");
    if (!ConnectionTypes.includes(type)) throw new Error("invalid_connection_type");
    const rawEnv = typeof input.env === "object" && input.env !== null ? input.env as Record<string, unknown> : {};
    const envEntries = Object.entries(rawEnv);
    if (envEntries.length === 0) throw new Error("missing_connection_env");

    const normalizedEnv: Record<string, string> = {};
    for (const [rawKey, rawValue] of envEntries) {
      const key = sanitizeEnvScalar(rawKey).toUpperCase();
      const value = sanitizeEnvScalar(rawValue).toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid_connection_env_key");
      if (!value || !this.isValidSecretName(value)) throw new Error("invalid_connection_env_value");
      normalizedEnv[key] = value;
    }

    const available = new Set(Object.keys(this.readSecretsEnv()));
    for (const secretRef of Object.values(normalizedEnv)) {
      if (!available.has(secretRef)) throw new Error("unknown_secret_name");
    }

    const spec = this.getSpec();
    const nextConnection = { id, name, type, env: normalizedEnv };
    const index = spec.connections.findIndex((connection) => connection.id === id);
    if (index >= 0) spec.connections[index] = nextConnection;
    else spec.connections.push(nextConnection);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    return nextConnection;
  }

  deleteConnection(idRaw: unknown) {
    const id = sanitizeEnvScalar(idRaw);
    if (!id) throw new Error("invalid_connection_id");
    const spec = this.getSpec();
    const index = spec.connections.findIndex((connection) => connection.id === id);
    if (index < 0) throw new Error("connection_not_found");
    spec.connections.splice(index, 1);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.renderArtifacts();
    return id;
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
