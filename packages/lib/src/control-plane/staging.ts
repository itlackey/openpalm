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
  readAdminCompose,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
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

// ── Stack Config (openpalm.yml) ─────────────────────────────────────

/**
 * Check whether Ollama is enabled by reading config/openpalm.yml.
 * Falls back to checking vault/system.env for legacy compatibility.
 */
export function isOllamaEnabled(state: ControlPlaneState): boolean {
  // Try openpalm.yml first
  const ymlPath = `${state.configDir}/openpalm.yml`;
  if (existsSync(ymlPath)) {
    const content = readFileSync(ymlPath, "utf-8");
    const match = content.match(/^\s*ollama:\s*(true|false)/m);
    if (match) return match[1] === "true";
  }

  // Legacy fallback: check system.env
  const systemEnvPath = `${state.vaultDir}/system.env`;
  if (!existsSync(systemEnvPath)) return false;
  const content = readFileSync(systemEnvPath, "utf-8");
  const match = content.match(/^OPENPALM_OLLAMA_ENABLED=(.+)$/m);
  return match?.[1]?.trim().toLowerCase() === "true";
}

/**
 * Check whether admin is enabled by reading config/openpalm.yml.
 * Falls back to checking vault/system.env for legacy compatibility.
 */
export function isAdminEnabled(state: ControlPlaneState): boolean {
  // Try openpalm.yml first
  const ymlPath = `${state.configDir}/openpalm.yml`;
  if (existsSync(ymlPath)) {
    const content = readFileSync(ymlPath, "utf-8");
    const match = content.match(/^\s*admin:\s*(true|false)/m);
    if (match) return match[1] === "true";
  }

  // Legacy fallback: check system.env
  const systemEnvPath = `${state.vaultDir}/system.env`;
  if (!existsSync(systemEnvPath)) return false;
  const content = readFileSync(systemEnvPath, "utf-8");
  const match = content.match(/^OPENPALM_ADMIN_ENABLED=(.+)$/m);
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
export function writeSystemEnv(state: ControlPlaneState): void {
  mkdirSync(state.vaultDir, { recursive: true });

  const systemEnvPath = `${state.vaultDir}/system.env`;

  let base = "";
  if (existsSync(systemEnvPath)) {
    base = readFileSync(systemEnvPath, "utf-8");
  } else {
    base = generateFallbackSystemEnv(state);
  }

  // Preserve existing OPENPALM_SETUP_COMPLETE=true
  const alreadyComplete = /^OPENPALM_SETUP_COMPLETE=true$/mi.test(base);

  const adminManaged: Record<string, string> = {
    OPENPALM_SETUP_COMPLETE: alreadyComplete ? "true" : "false"
  };
  for (const [ch, secret] of Object.entries(state.channelSecrets)) {
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
    "# ── Paths ──────────────────────────────────────────────────────────",
    `OPENPALM_HOME=${state.homeDir}`,
    `OPENPALM_UID=${uid}`,
    `OPENPALM_GID=${gid}`,
    `OPENPALM_DOCKER_SOCK=${process.env.OPENPALM_DOCKER_SOCK ?? "/var/run/docker.sock"}`,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OPENPALM_IMAGE_NAMESPACE=${process.env.OPENPALM_IMAGE_NAMESPACE ?? "openpalm"}`,
    `OPENPALM_IMAGE_TAG=${DEFAULT_IMAGE_TAG}`,
    "",
    "# ── Ports (38XX range) ──────────────────────────────────────────────",
    `OPENPALM_ASSISTANT_PORT=3800`,
    `OPENPALM_ADMIN_PORT=3880`,
    `OPENPALM_ADMIN_OPENCODE_PORT=3881`,
    `OPENPALM_SCHEDULER_PORT=3897`,
    `OPENPALM_MEMORY_PORT=3898`,
    `OPENPALM_GUARDIAN_PORT=3899`,
    `OPENPALM_INGRESS_PORT=3880`,
    "",
    "# ── Networking ──────────────────────────────────────────────────────",
    "# SECURITY: Bind addresses default to 127.0.0.1. Changing to 0.0.0.0 exposes services publicly.",
    `OPENPALM_INGRESS_BIND_ADDRESS=${process.env.OPENPALM_INGRESS_BIND_ADDRESS ?? "127.0.0.1"}`,
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
  if (isOllamaEnabled(state)) {
    writeComponentOverlay(state, "ollama", readOllamaCompose(assets));
  }

  if (isAdminEnabled(state)) {
    writeComponentOverlay(state, "admin", readAdminCompose(assets));
  }

  // Ensure channel HMAC secrets
  const allChannels = discoverChannels(state.configDir);
  for (const ch of allChannels) {
    if (!state.channelSecrets[ch.name]) {
      state.channelSecrets[ch.name] = randomHex(16);
    }
  }

  // Write system.env with channel secrets and system values
  writeSystemEnv(state);

  // Write channel Caddy routes
  writeCaddyRoutes(state);

  // Write env schemas to vault
  ensureUserEnvSchema(assets);
  ensureSystemEnvSchema(assets);

  state.artifactMeta = buildArtifactMeta(state.artifacts);
}

// ── Legacy Compat Aliases ────────────────────────────────────────────

/** @deprecated Use resolveArtifacts() */
export const stageArtifacts = resolveArtifacts;

/** @deprecated Use persistConfiguration() */
export const persistArtifacts = persistConfiguration;

/** @deprecated Use discoverComponentOverlays() */
export function discoverStagedChannelYmls(stateDir: string): string[] {
  // In the new layout, stateDir is no longer used for artifacts.
  // Look in the config/components directory instead.
  // Callers should migrate to discoverChannelOverlays(configDir).
  return [];
}
