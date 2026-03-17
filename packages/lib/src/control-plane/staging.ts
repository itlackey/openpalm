/**
 * Artifact staging pipeline for the OpenPalm control plane.
 *
 * Stages artifacts from CONFIG_HOME/DATA_HOME into STATE_HOME:
 * Caddyfile/compose staging, env staging, channel/automation file staging,
 * and artifact persistence.
 *
 * All asset content is provided by a CoreAssetProvider (injected).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { discoverChannels } from "./channels.js";
import { appendAudit } from "./audit.js";
import { parseAutomationYaml } from "./scheduler.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import {
  readCoreCaddyfile,
  readCoreCompose,
  readOllamaCompose,
  ensureSecretsSchema,
  ensureStackSchema,
  PUBLIC_ACCESS_IMPORT,
  LAN_ONLY_IMPORT
} from "./core-assets.js";

const DEFAULT_IMAGE_TAG = process.env.OPENPALM_IMAGE_TAG ?? "latest";

// ── Crypto Utilities ──────────────────────────────────────────────────

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Generate a hex string using Node's crypto.randomBytes (CSPRNG). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ── Ollama State ─────────────────────────────────────────────────────

/**
 * Check whether Ollama is enabled in the stack by reading the
 * OPENPALM_OLLAMA_ENABLED flag from DATA_HOME/stack.env.
 */
export function isOllamaEnabled(state: ControlPlaneState): boolean {
  const stackEnvPath = `${state.dataDir}/stack.env`;
  if (!existsSync(stackEnvPath)) return false;
  const content = readFileSync(stackEnvPath, "utf-8");
  const match = content.match(/^OPENPALM_OLLAMA_ENABLED=(.+)$/m);
  return match?.[1]?.trim().toLowerCase() === "true";
}

// ── Caddyfile Staging ─────────────────────────────────────────────────

function withDefaultLanOnly(rawCaddy: string): string | null {
  if (rawCaddy.includes(PUBLIC_ACCESS_IMPORT) || rawCaddy.includes(LAN_ONLY_IMPORT)) {
    return rawCaddy;
  }

  const blockStarts = [
    /(handle_path\s+[^\n{]+\{\s*\n?)/,
    /(handle\s+[^\n{]+\{\s*\n?)/,
    /(route\s+[^\n{]+\{\s*\n?)/
  ];

  for (const pattern of blockStarts) {
    if (pattern.test(rawCaddy)) {
      return rawCaddy.replace(pattern, "$1\timport lan_only\n");
    }
  }

  return null;
}

function stageChannelCaddyfiles(state: ControlPlaneState): void {
  const stagedChannelsDir = `${state.stateDir}/artifacts/channels`;
  const stagedPublicDir = `${stagedChannelsDir}/public`;
  const stagedLanDir = `${stagedChannelsDir}/lan`;
  rmSync(stagedPublicDir, { recursive: true, force: true });
  rmSync(stagedLanDir, { recursive: true, force: true });
  mkdirSync(stagedPublicDir, { recursive: true });
  mkdirSync(stagedLanDir, { recursive: true });

  const channels = discoverChannels(state.configDir);
  for (const ch of channels) {
    if (!ch.caddyPath) continue;

    const raw = readFileSync(ch.caddyPath, "utf-8");
    if (raw.includes(PUBLIC_ACCESS_IMPORT)) {
      writeFileSync(`${stagedPublicDir}/${ch.name}.caddy`, raw);
      continue;
    }

    const lanScoped = withDefaultLanOnly(raw);
    if (!lanScoped) {
      appendAudit(
        state,
        "system",
        "channels.route.skip",
        {
          channel: ch.name,
          reason: "Unable to infer route block for default LAN scoping"
        },
        false,
        "",
        "system"
      );
      continue;
    }
    writeFileSync(`${stagedLanDir}/${ch.name}.caddy`, lanScoped);
  }
}

function stageCaddyfile(_state: ControlPlaneState, assets: CoreAssetProvider): string {
  return readCoreCaddyfile(assets);
}

// ── Compose Staging ───────────────────────────────────────────────────

function stageCompose(_state: ControlPlaneState, assets: CoreAssetProvider): string {
  return readCoreCompose(assets);
}

// ── Env Staging ───────────────────────────────────────────────────────

function stageSecretsEnv(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  mkdirSync(artifactDir, { recursive: true });

  const source = `${state.configDir}/secrets.env`;
  const content = existsSync(source) ? readFileSync(source, "utf-8") : "";
  writeFileSync(`${artifactDir}/secrets.env`, content);
}

/** Return the path to the staged secrets.env in STATE_HOME. */
export function stagedEnvFile(state: ControlPlaneState): string {
  return `${state.stateDir}/artifacts/secrets.env`;
}

/** Return the path to the staged stack.env in STATE_HOME. */
export function stagedStackEnvFile(state: ControlPlaneState): string {
  return `${state.stateDir}/artifacts/stack.env`;
}

/**
 * Return both staged env files in load order: [stack.env, secrets.env].
 * Non-existent files are omitted so docker compose does not error.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [stagedStackEnvFile(state), stagedEnvFile(state)].filter(existsSync);
}

function stageStackEnv(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  mkdirSync(artifactDir, { recursive: true });

  const dataStackEnv = `${state.dataDir}/stack.env`;

  let base = "";
  if (existsSync(dataStackEnv)) {
    base = readFileSync(dataStackEnv, "utf-8");
  } else {
    base = generateFallbackStackEnv(state);
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(dataStackEnv, base);
  }

  const adminManaged: Record<string, string> = {
    OPENPALM_SETUP_COMPLETE: state.adminToken ? "true" : "false"
  };
  for (const [ch, secret] of Object.entries(state.channelSecrets)) {
    adminManaged[`CHANNEL_${ch.toUpperCase()}_SECRET`] = secret;
  }

  const content = mergeEnvContent(base, adminManaged, {
    sectionHeader: "# ── Admin-managed ──────────────────────────────────────────────────"
  });

  writeFileSync(dataStackEnv, content);
  writeFileSync(`${artifactDir}/stack.env`, content);
}

function generateFallbackStackEnv(state: ControlPlaneState): string {
  const uid = typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000;
  const gid = typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000;

  const home = process.env.HOME ?? "/home/node";
  const workDir = process.env.OPENPALM_WORK_DIR ?? `${home}/openpalm`;

  return [
    "# OpenPalm Stack Configuration — system-managed, do not edit",
    "# Auto-generated fallback (setup.sh has not run yet).",
    "",
    "# ── XDG Paths ──────────────────────────────────────────────────────",
    `OPENPALM_CONFIG_HOME=${state.configDir}`,
    `OPENPALM_DATA_HOME=${state.dataDir}`,
    `OPENPALM_STATE_HOME=${state.stateDir}`,
    `OPENPALM_WORK_DIR=${workDir}`,
    "",
    "# ── User/Group ──────────────────────────────────────────────────────",
    `OPENPALM_UID=${uid}`,
    `OPENPALM_GID=${gid}`,
    "",
    "# ── Docker Socket ───────────────────────────────────────────────────",
    `OPENPALM_DOCKER_SOCK=${process.env.OPENPALM_DOCKER_SOCK ?? "/var/run/docker.sock"}`,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OPENPALM_IMAGE_NAMESPACE=${process.env.OPENPALM_IMAGE_NAMESPACE ?? "openpalm"}`,
    `OPENPALM_IMAGE_TAG=${DEFAULT_IMAGE_TAG}`,
    "",
    "# ── Networking ──────────────────────────────────────────────────────",
    "# SECURITY: Bind addresses default to 127.0.0.1. Changing to 0.0.0.0 exposes services publicly.",
    `OPENPALM_INGRESS_BIND_ADDRESS=${process.env.OPENPALM_INGRESS_BIND_ADDRESS ?? "127.0.0.1"}`,
    `OPENPALM_INGRESS_PORT=${process.env.OPENPALM_INGRESS_PORT ?? "8080"}`,
    "",
    "# ── Channel HMAC Secrets ────────────────────────────────────────────",
    ""
  ].join("\n");
}

// ── Channel YML Staging ───────────────────────────────────────────────

function stageChannelYmlFiles(state: ControlPlaneState): void {
  const stagedChannelsDir = `${state.stateDir}/artifacts/channels`;
  mkdirSync(stagedChannelsDir, { recursive: true });

  for (const f of readdirSync(stagedChannelsDir)) {
    if (f.endsWith(".yml")) {
      rmSync(`${stagedChannelsDir}/${f}`, { force: true });
    }
  }

  const channels = discoverChannels(state.configDir);
  for (const ch of channels) {
    const content = readFileSync(ch.ymlPath, "utf-8");
    writeFileSync(`${stagedChannelsDir}/${ch.name}.yml`, content);
  }
}

/**
 * Discover staged channel .yml overlays from STATE_HOME/artifacts/channels/.
 */
export function discoverStagedChannelYmls(stateDir: string): string[] {
  const channelsDir = `${stateDir}/artifacts/channels`;
  if (!existsSync(channelsDir)) return [];

  return readdirSync(channelsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => `${channelsDir}/${entry.name}`);
}

// ── Automation Staging ───────────────────────────────────────────────

const AUTOMATION_FILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}\.yml$/;

function discoverAutomationFiles(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .filter((entry) => AUTOMATION_FILE_NAME_RE.test(entry.name));
}

function validateAutomationContent(content: string, fileName: string): boolean {
  return parseAutomationYaml(content, fileName) !== null;
}

function stageAutomationFiles(state: ControlPlaneState): void {
  const stagedDir = `${state.stateDir}/automations`;
  mkdirSync(stagedDir, { recursive: true });

  for (const f of readdirSync(stagedDir)) {
    const fullPath = `${stagedDir}/${f}`;
    if (!f.startsWith(".")) {
      rmSync(fullPath, { force: true });
    }
  }

  const systemDir = `${state.dataDir}/automations`;
  for (const entry of discoverAutomationFiles(systemDir)) {
    const content = readFileSync(entry.path, "utf-8");
    if (!validateAutomationContent(content, entry.name)) continue;
    writeFileSync(`${stagedDir}/${entry.name}`, content);
  }

  const userDir = `${state.configDir}/automations`;
  for (const entry of discoverAutomationFiles(userDir)) {
    const content = readFileSync(entry.path, "utf-8");
    if (!validateAutomationContent(content, entry.name)) continue;
    writeFileSync(`${stagedDir}/${entry.name}`, content);
  }
}

// ── Env Schema Staging ────────────────────────────────────────────────

function stageEnvSchemas(state: ControlPlaneState, assets: CoreAssetProvider): void {
  const destDir = `${state.dataDir}/assistant/env-schema`;
  mkdirSync(destDir, { recursive: true });

  const secretsSchemaPath = ensureSecretsSchema(assets);
  const stackSchemaPath = ensureStackSchema(assets);

  copyFileSync(secretsSchemaPath, `${destDir}/secrets.env.schema`);
  copyFileSync(stackSchemaPath, `${destDir}/stack.env.schema`);
}

// ── Top-Level Staging ─────────────────────────────────────────────────

export function stageArtifacts(
  state: ControlPlaneState,
  assets: CoreAssetProvider
): {
  compose: string;
  caddyfile: string;
} {
  return {
    compose: stageCompose(state, assets),
    caddyfile: stageCaddyfile(state, assets)
  };
}

// ── Artifact Metadata ──────────────────────────────────────────────────

export function buildArtifactMeta(artifacts: {
  compose: string;
  caddyfile: string;
}): ArtifactMeta[] {
  const now = new Date().toISOString();
  return (["compose", "caddyfile"] as const).map((name) => ({
    name,
    sha256: sha256(artifacts[name]),
    generatedAt: now,
    bytes: Buffer.byteLength(artifacts[name])
  }));
}

// ── Persistence ────────────────────────────────────────────────────────

export function persistArtifacts(
  state: ControlPlaneState,
  assets: CoreAssetProvider
): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  const channelsDir = `${state.configDir}/channels`;
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });

  writeFileSync(`${artifactDir}/docker-compose.yml`, state.artifacts.compose);
  writeFileSync(`${artifactDir}/Caddyfile`, state.artifacts.caddyfile);

  if (isOllamaEnabled(state)) {
    writeFileSync(`${artifactDir}/ollama.yml`, readOllamaCompose(assets));
  }

  const allChannels = discoverChannels(state.configDir);
  for (const ch of allChannels) {
    if (!state.channelSecrets[ch.name]) {
      state.channelSecrets[ch.name] = randomHex(16);
    }
  }
  stageStackEnv(state);
  stageSecretsEnv(state);
  stageChannelYmlFiles(state);
  stageChannelCaddyfiles(state);
  stageAutomationFiles(state);
  stageEnvSchemas(state, assets);

  state.artifactMeta = buildArtifactMeta(state.artifacts);
  writeFileSync(
    `${artifactDir}/manifest.json`,
    JSON.stringify(state.artifactMeta, null, 2)
  );
}
