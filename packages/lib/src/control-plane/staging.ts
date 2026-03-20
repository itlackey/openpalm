/**
 * Configuration management for the OpenPalm control plane (v0.10.0+).
 *
 * Replaces the permanent staging pipeline with direct-write operations.
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 *
 * All asset content is provided by a CoreAssetProvider (injected).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { discoverChannels } from "./channels.js";
import { readStackSpec } from "./stack-spec.js";
import { appendAudit } from "./audit.js";
import { parseAutomationYaml } from "./scheduler.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import { generateRedactSchema } from "./redact-schema.js";
import { readSystemSecretsEnvFile } from "./secrets.js";
import {
  readCoreCaddyfile,
  readCoreCompose,
  readAdminCompose,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
  PUBLIC_ACCESS_IMPORT,
  LAN_ONLY_IMPORT
} from "./core-assets.js";

const DEFAULT_IMAGE_TAG = process.env.OP_IMAGE_TAG ?? "latest";

// ── Crypto Utilities ──────────────────────────────────────────────────

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Generate a hex string using Node's crypto.randomBytes (CSPRNG). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ── Stack Config (openpalm.yml) ─────────────────────────────────────

/**
 * Check whether Ollama is enabled. Reads from the StackSpec (v3 or v4,
 * auto-upgraded) first, then falls back to vault/system.env for legacy
 * installations that haven't been migrated yet.
 */
export function isOllamaEnabled(state: ControlPlaneState): boolean {
  // Try the StackSpec first (handles both .yaml and .yml, v3 and v4)
  const spec = readStackSpec(state.configDir);
  if (spec) return spec.features?.ollama === true;

  // Lightweight legacy fallback: check openpalm.yml for plain boolean flags
  const ymlPath = `${state.configDir}/openpalm.yml`;
  if (existsSync(ymlPath)) {
    try {
      const ymlContent = readFileSync(ymlPath, "utf-8");
      const ymlMatch = ymlContent.match(/^\s*ollama:\s*(true|false)/m);
      if (ymlMatch) return ymlMatch[1] === "true";
    } catch { /* ignore */ }
  }

  // Legacy fallback: check system.env
  const systemEnvPath = `${state.vaultDir}/system.env`;
  if (!existsSync(systemEnvPath)) return false;
  const content = readFileSync(systemEnvPath, "utf-8");
  const match = content.match(/^(?:OP_|OP_)OLLAMA_ENABLED=(.+)$/m);
  return match?.[1]?.trim().toLowerCase() === "true";
}

/**
 * Check whether admin is enabled. Reads from the StackSpec (v3 or v4,
 * auto-upgraded) first, then falls back to vault/system.env for legacy
 * installations that haven't been migrated yet.
 */
export function isAdminEnabled(state: ControlPlaneState): boolean {
  // Try the StackSpec first (handles both .yaml and .yml, v3 and v4)
  const spec = readStackSpec(state.configDir);
  if (spec) return spec.features?.admin === true;

  // Lightweight legacy fallback: check openpalm.yml for plain boolean flags
  const ymlPath = `${state.configDir}/openpalm.yml`;
  if (existsSync(ymlPath)) {
    try {
      const ymlContent = readFileSync(ymlPath, "utf-8");
      const ymlMatch = ymlContent.match(/^\s*admin:\s*(true|false)/m);
      if (ymlMatch) return ymlMatch[1] === "true";
    } catch { /* ignore */ }
  }

  // Legacy fallback: check system.env
  const systemEnvPath = `${state.vaultDir}/system.env`;
  if (!existsSync(systemEnvPath)) return false;
  const content = readFileSync(systemEnvPath, "utf-8");
  const match = content.match(/^(?:OP_|OP_)ADMIN_ENABLED=(.+)$/m);
  return match?.[1]?.trim().toLowerCase() === "true";
}

// ── Caddyfile Management ─────────────────────────────────────────────

export function withDefaultLanOnly(rawCaddy: string): string | null {
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

/**
 * Write channel Caddy route files to data/caddy/channels/{public,lan}/.
 */
export function writeCaddyRoutes(state: ControlPlaneState): void {
  const caddyChannelsDir = `${state.dataDir}/caddy/channels`;
  const publicDir = `${caddyChannelsDir}/public`;
  const lanDir = `${caddyChannelsDir}/lan`;
  rmSync(publicDir, { recursive: true, force: true });
  rmSync(lanDir, { recursive: true, force: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(lanDir, { recursive: true });

  const channels = discoverChannels(state.configDir);
  for (const ch of channels) {
    if (!ch.caddyPath) continue;

    const raw = readFileSync(ch.caddyPath, "utf-8");
    if (raw.includes(PUBLIC_ACCESS_IMPORT)) {
      writeFileSync(`${publicDir}/${ch.name}.caddy`, raw);
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
    writeFileSync(`${lanDir}/${ch.name}.caddy`, lanScoped);
  }
}

// ── Compose & Caddyfile Content ──────────────────────────────────────

function resolveCompose(_state: ControlPlaneState, assets: CoreAssetProvider): string {
  return readCoreCompose(assets);
}

function resolveCaddyfile(_state: ControlPlaneState, assets: CoreAssetProvider): string {
  return readCoreCaddyfile(assets);
}

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 * In v0.10.0, these are the live vault env files (no staging).
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [
    `${state.vaultDir}/system.env`,
    `${state.vaultDir}/user.env`,
  ].filter(existsSync);
}

/**
 * Write system-managed values to vault/system.env.
 */
export function writeSystemEnv(state: ControlPlaneState, channelSecrets: Record<string, string> = {}): void {
  mkdirSync(state.vaultDir, { recursive: true });

  const systemEnvPath = `${state.vaultDir}/system.env`;

  let base = "";
  if (existsSync(systemEnvPath)) {
    base = readFileSync(systemEnvPath, "utf-8");
  } else {
    base = generateFallbackSystemEnv(state);
  }

  // Preserve existing OP_SETUP_COMPLETE=true
  const alreadyComplete = /^OP_SETUP_COMPLETE=true$/mi.test(base);

  const adminManaged: Record<string, string> = {
    OP_SETUP_COMPLETE: alreadyComplete ? "true" : "false"
  };
  for (const [ch, secret] of Object.entries(channelSecrets)) {
    adminManaged[`CHANNEL_${ch.toUpperCase()}_SECRET`] = secret;
  }

  const content = mergeEnvContent(base, adminManaged, {
    sectionHeader: "# ── Admin-managed ──────────────────────────────────────────────────"
  });

  writeFileSync(systemEnvPath, content);
}

function generateFallbackSystemEnv(state: ControlPlaneState): string {
  const uid = typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000;
  const gid = typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000;

  return [
    "# OpenPalm — System Configuration (managed by CLI/admin)",
    "# Auto-generated fallback.",
    "",
    "# ── Authentication ──────────────────────────────────────────────────",
    `OP_ADMIN_TOKEN=${state.adminToken}`,
    `ASSISTANT_TOKEN=${state.assistantToken}`,
    "",
    "# ── Service Auth ─────────────────────────────────────────────────────",
    `MEMORY_AUTH_TOKEN=${process.env.MEMORY_AUTH_TOKEN ?? ""}`,
    "OPENCODE_SERVER_PASSWORD=",
    "",
    "# ── Paths ──────────────────────────────────────────────────────────",
    `OP_HOME=${state.homeDir}`,
    `OP_UID=${uid}`,
    `OP_GID=${gid}`,
    `OP_DOCKER_SOCK=${process.env.OP_DOCKER_SOCK ?? "/var/run/docker.sock"}`,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OP_IMAGE_NAMESPACE=${process.env.OP_IMAGE_NAMESPACE ?? "openpalm"}`,
    `OP_IMAGE_TAG=${DEFAULT_IMAGE_TAG}`,
    "",
    "# ── Ports (38XX range) ──────────────────────────────────────────────",
    `OP_ASSISTANT_PORT=3800`,
    `OP_ADMIN_PORT=3880`,
    `OP_ADMIN_OPENCODE_PORT=3881`,
    `OP_SCHEDULER_PORT=3897`,
    `OP_MEMORY_PORT=3898`,
    `OP_GUARDIAN_PORT=3899`,
    `OP_INGRESS_PORT=3080`,
    "",
    "# ── Networking ──────────────────────────────────────────────────────",
    "# SECURITY: Bind addresses default to 127.0.0.1. Changing to 0.0.0.0 exposes services publicly.",
    `OP_INGRESS_BIND_ADDRESS=${process.env.OP_INGRESS_BIND_ADDRESS ?? "127.0.0.1"}`,
    "",
    "# ── Channel HMAC Secrets ────────────────────────────────────────────",
    ""
  ].join("\n");
}

// ── Component Overlay Management ──────────────────────────────────────

/**
 * Write a compose overlay to config/components/.
 */
export function writeComponentOverlay(state: ControlPlaneState, name: string, content: string): void {
  const dir = `${state.configDir}/components`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.yml`, content);
}

/**
 * Discover component overlays from config/components/.
 * Returns full paths to .yml files.
 */
export function discoverComponentOverlays(configDir: string): string[] {
  const componentsDir = `${configDir}/components`;
  if (!existsSync(componentsDir)) return [];

  return readdirSync(componentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => `${componentsDir}/${entry.name}`);
}

/**
 * Discover channel component overlays specifically (channel-*.yml).
 */
export function discoverChannelOverlays(configDir: string): string[] {
  return discoverComponentOverlays(configDir)
    .filter((p) => {
      const name = p.split("/").pop() ?? "";
      return name.startsWith("channel-");
    });
}

// ── Automation Management ────────────────────────────────────────────

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

// ── Top-Level Operations ─────────────────────────────────────────────

export function resolveArtifacts(
  state: ControlPlaneState,
  assets: CoreAssetProvider
): {
  compose: string;
  caddyfile: string;
} {
  return {
    compose: resolveCompose(state, assets),
    caddyfile: resolveCaddyfile(state, assets)
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

// ── Channel Secrets ────────────────────────────────────────────────────

/** Load persisted CHANNEL_*_SECRET entries from vault/system.env. */
function loadPersistedChannelSecrets(vaultDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${vaultDir}/system.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const match = key.match(/^CHANNEL_([A-Z0-9_]+)_SECRET$/);
    if (match?.[1] && value) result[match[1].toLowerCase()] = value;
  }
  return result;
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function persistConfiguration(
  state: ControlPlaneState,
  assets: CoreAssetProvider
): void {
  const componentsDir = `${state.configDir}/components`;
  mkdirSync(componentsDir, { recursive: true });

  // Write core compose overlay
  writeComponentOverlay(state, "core", state.artifacts.compose);

  // Write Caddyfile to data/caddy/
  const caddyDir = `${state.dataDir}/caddy`;
  mkdirSync(caddyDir, { recursive: true });
  writeFileSync(`${caddyDir}/Caddyfile`, state.artifacts.caddyfile);

  // Write optional compose overlays
  if (isAdminEnabled(state)) {
    writeComponentOverlay(state, "admin", readAdminCompose(assets));
  }

  // Load persisted channel HMAC secrets, generate new ones for new channels
  const channelSecrets = loadPersistedChannelSecrets(state.vaultDir);
  const allChannels = discoverChannels(state.configDir);
  for (const ch of allChannels) {
    if (!channelSecrets[ch.name]) {
      channelSecrets[ch.name] = randomHex(16);
    }
  }

  // Write system.env with channel secrets and system values
  writeSystemEnv(state, channelSecrets);

  // Write channel Caddy routes
  writeCaddyRoutes(state);

  // Write env schemas to vault
  ensureUserEnvSchema(assets);
  ensureSystemEnvSchema(assets);

  // Generate redact.env.schema from canonical mappings
  const systemEnv = readSystemSecretsEnvFile(state.vaultDir);
  const redactDir = `${state.dataDir}/secrets`;
  mkdirSync(redactDir, { recursive: true });
  writeFileSync(`${redactDir}/redact.env.schema`, generateRedactSchema(systemEnv));

  state.artifactMeta = buildArtifactMeta(state.artifacts);
}
