import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateStackArtifacts } from "./stack-generator.ts";
import { channelEnvSecretVariable, ensureStackSpec, parseStackSpec, stringifyStackSpec } from "./stack-spec.ts";
import { parseJsonc, stringifyPretty } from "../jsonc.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, updateRuntimeEnvContent } from "../runtime-env.ts";
import { validatePluginIdentifier } from "../extensions.ts";
import type { ConnectionType, ExtensionType, StackSpec } from "./stack-spec.ts";

export type ChannelName = "chat" | "discord" | "voice" | "telegram";

const Channels: ChannelName[] = ["chat", "discord", "voice", "telegram"];
const ConnectionTypes: ConnectionType[] = ["ai_provider", "platform", "api_service"];
const ExtensionTypes: ExtensionType[] = ["plugin", "skill", "command", "agent", "tool"];

export type StackManagerPaths = {
  caddyfilePath: string;
  composeFilePath: string;
  secretsEnvPath: string;
  stackSpecPath: string;
  channelEnvDir: string;
  channelSecretDir: string;
  gatewayChannelSecretsPath: string;
  opencodeConfigPath: string;
};

export const CoreSecretRequirements = [
  { service: "admin", key: "ADMIN_TOKEN", required: true },
  { service: "postgres", key: "POSTGRES_PASSWORD", required: true },
] as const;

export class StackManager {
  constructor(private readonly paths: StackManagerPaths) {}

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
    writeFileSync(this.paths.composeFilePath, generated.composeFile, "utf8");
    this.mergeOpencodePluginConfig(generated.opencodePluginIds);

    mkdirSync(dirname(this.paths.gatewayChannelSecretsPath), { recursive: true });
    writeFileSync(this.paths.gatewayChannelSecretsPath, generated.gatewayChannelSecretsEnv, "utf8");

    mkdirSync(this.paths.channelSecretDir, { recursive: true });
    mkdirSync(this.paths.channelEnvDir, { recursive: true });

    for (const [channel, content] of Object.entries(generated.channelSecretsEnv)) {
      writeFileSync(this.channelSecretEnvPath(channel as ChannelName), content, "utf8");
    }
    for (const [channel, content] of Object.entries(generated.channelConfigEnv)) {
      writeFileSync(this.channelConfigEnvPath(channel as ChannelName), content, "utf8");
    }

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
      for (const envKey of Object.keys(connection.env)) {
        const list = usedBy.get(envKey) ?? [];
        list.push(`connection:${connection.id}`);
        usedBy.set(envKey, list);
      }
    }

    for (const channel of Channels) {
      for (const [target, key] of [["gateway", spec.secrets.gatewayChannelSecrets[channel]], ["channel", spec.secrets.channelServiceSecrets[channel]]]) {
        const list = usedBy.get(key) ?? [];
        list.push(`${target}:${channel}`);
        usedBy.set(key, list);
      }
    }

    const uniqueNames = Array.from(new Set([...spec.secrets.available, ...Object.keys(secretValues)])).sort();
    return {
      available: uniqueNames,
      mappings: spec.secrets,
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
    const spec = this.getSpec();
    if (!spec.secrets.available.includes(name)) {
      spec.secrets.available.push(name);
      spec.secrets.available.sort();
      this.writeStackSpecAtomically(stringifyStackSpec(spec));
    }
    this.renderArtifacts();
    return name;
  }

  deleteSecret(nameRaw: unknown) {
    const name = sanitizeEnvScalar(nameRaw).toUpperCase();
    if (!this.isValidSecretName(name)) throw new Error("invalid_secret_name");
    const spec = this.getSpec();
    const usedByChannel = Channels.some((channel) => spec.secrets.gatewayChannelSecrets[channel] === name || spec.secrets.channelServiceSecrets[channel] === name);
    const usedByCore = CoreSecretRequirements.some((item) => item.key === name);
    const usedByConnection = spec.connections.some((connection) => Object.keys(connection.env).includes(name));
    if (usedByChannel || usedByCore || usedByConnection) throw new Error("secret_in_use");
    spec.secrets.available = spec.secrets.available.filter((value) => value !== name);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
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
    if (!spec.secrets.available.includes(secretName)) throw new Error("unknown_secret_name");
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
    const secretEntries: Record<string, string | undefined> = {};
    for (const [rawKey, rawValue] of envEntries) {
      const key = sanitizeEnvScalar(rawKey).toUpperCase();
      const value = sanitizeEnvScalar(rawValue);
      if (!/^OPENPALM_CONN_[A-Z0-9_]+$/.test(key)) throw new Error("invalid_connection_env_key");
      if (!value) throw new Error("invalid_connection_env_value");
      normalizedEnv[key] = value;
      secretEntries[key] = value;
    }

    this.updateSecretsEnv(secretEntries);
    const spec = this.getSpec();
    for (const key of Object.keys(normalizedEnv)) {
      if (!spec.secrets.available.includes(key)) spec.secrets.available.push(key);
    }
    spec.secrets.available.sort();
    const nextConnection = { id, name, type, env: normalizedEnv };
    const index = spec.connections.findIndex((connection) => connection.id === id);
    if (index >= 0) spec.connections[index] = nextConnection;
    else spec.connections.push(nextConnection);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    return nextConnection;
  }

  deleteConnection(connectionIdRaw: unknown) {
    const connectionId = sanitizeEnvScalar(connectionIdRaw);
    if (!connectionId) throw new Error("invalid_connection_id");
    const spec = this.getSpec();
    const usedByExtensions = spec.extensions.some((extension) => (extension.connectionIds ?? []).includes(connectionId));
    if (usedByExtensions) throw new Error("connection_in_use");
    const connection = spec.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error("connection_not_found");

    spec.connections = spec.connections.filter((entry) => entry.id !== connectionId);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    return connectionId;
  }

  listInstalled() {
    const generated = this.renderPreview();
    return { plugins: generated.opencodePluginIds, extensions: this.getSpec().extensions };
  }

  setExtensionInstalled(input: {
    extensionId: string;
    type: ExtensionType;
    enabled: boolean;
    pluginId?: string;
    connectionIds?: string[];
  }) {
    if (!ExtensionTypes.includes(input.type)) throw new Error("invalid_extension_type");
    if (!input.extensionId.trim()) throw new Error("invalid_extension_id");
    if (input.type === "plugin") {
      if (!input.pluginId || !validatePluginIdentifier(input.pluginId)) throw new Error("invalid_plugin_id");
    }

    const spec = this.getSpec();
    const connectionIdSet = new Set(spec.connections.map((connection) => connection.id));
    const connectionIds = (input.connectionIds ?? []).filter((entry) => entry.trim().length > 0);
    for (const connectionId of connectionIds) {
      if (!connectionIdSet.has(connectionId)) throw new Error("unknown_extension_connection");
    }

    const next = {
      id: input.extensionId,
      type: input.type,
      enabled: input.enabled,
      pluginId: input.pluginId,
      connectionIds,
    };

    const index = spec.extensions.findIndex((extension) => extension.id === input.extensionId);
    if (index >= 0) spec.extensions[index] = next;
    else spec.extensions.push(next);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.renderArtifacts();
    return next;
  }

  private mergeOpencodePluginConfig(plugins: string[]) {
    const config = this.readOpencodeConfig();
    this.writeOpencodeConfig({ ...config, plugin: plugins });
  }

  private readOpencodeConfig(): Record<string, unknown> & { plugin?: string[] } {
    mkdirSync(dirname(this.paths.opencodeConfigPath), { recursive: true });
    if (!existsSync(this.paths.opencodeConfigPath)) writeFileSync(this.paths.opencodeConfigPath, "{}\n", "utf8");
    return parseJsonc(readFileSync(this.paths.opencodeConfigPath, "utf8")) as Record<string, unknown> & { plugin?: string[] };
  }

  private writeOpencodeConfig(config: Record<string, unknown> & { plugin?: string[] }) {
    const tmpPath = `${this.paths.opencodeConfigPath}.${Date.now()}.tmp`;
    const content = stringifyPretty(config);
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, this.paths.opencodeConfigPath);
  }

  private channelSecretEnvPath(channel: ChannelName) {
    return `${this.paths.channelSecretDir}/${channel}.env`;
  }

  private channelConfigEnvPath(channel: ChannelName) {
    return `${this.paths.channelEnvDir}/${channel}.env`;
  }

  private isValidSecretName(name: string) {
    return /^[A-Z][A-Z0-9_]{1,127}$/.test(name);
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

  private writeStackSpecAtomically(content: string) {
    const tmpPath = `${this.paths.stackSpecPath}.${Date.now()}.tmp`;
    mkdirSync(dirname(this.paths.stackSpecPath), { recursive: true });
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, this.paths.stackSpecPath);
  }
}
