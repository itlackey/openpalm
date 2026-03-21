/**
 * Configuration management for the OpenPalm control plane (v0.10.0+).
 *
 * Replaces the permanent staging pipeline with direct-write operations.
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 *
 * All asset content is provided by a CoreAssetProvider (injected).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { discoverChannels } from "./channels.js";
import { readStackSpec, hasAddon } from "./stack-spec.js";
import { writeManagedEnvFiles } from "./spec-to-env.js";

import { parseAutomationYaml } from "./scheduler.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import { generateRedactSchema } from "./redact-schema.js";
import { readSystemSecretsEnvFile } from "./secrets.js";
import {
  readCoreCompose,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
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

// ── Stack Config (stack.yaml) ─────────────────────────────────────

/**
 * Check whether Ollama is enabled via stack.yaml addons list.
 */
export function isOllamaEnabled(state: ControlPlaneState): boolean {
  const spec = readStackSpec(state.configDir);
  if (spec) return hasAddon(spec, "ollama");
  return false;
}

/**
 * Check whether admin is enabled via stack.yaml addons list.
 */
export function isAdminEnabled(state: ControlPlaneState): boolean {
  const spec = readStackSpec(state.configDir);
  if (spec) return hasAddon(spec, "admin");
  return false;
}

// ── Compose Content ──────────────────────────────────────────────────

function resolveCompose(_state: ControlPlaneState, assets: CoreAssetProvider): string {
  return readCoreCompose(assets);
}

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 * In v0.10.0, these are the live vault env files (no staging).
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [
    `${state.vaultDir}/stack/stack.env`,
    `${state.vaultDir}/stack/services/memory/managed.env`,
    `${state.vaultDir}/user/user.env`,
  ].filter(existsSync);
}

/**
 * Write system-managed values to vault/stack/stack.env.
 */
export function writeSystemEnv(state: ControlPlaneState, channelSecrets: Record<string, string> = {}): void {
  mkdirSync(`${state.vaultDir}/stack`, { recursive: true });

  const systemEnvPath = `${state.vaultDir}/stack/stack.env`;

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

// ── Stack Overlay Discovery ────────────────────────────────────────────

/**
 * Discover compose overlays from the stack directory.
 * Returns full paths: [stack/core.compose.yml, stack/addons/{name}/compose.yml].
 */
export function discoverStackOverlays(stackDir: string): string[] {
  const files: string[] = [];

  const coreYml = `${stackDir}/core.compose.yml`;
  if (existsSync(coreYml)) files.push(coreYml);

  const addonsDir = `${stackDir}/addons`;
  if (existsSync(addonsDir)) {
    const entries = readdirSync(addonsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const addonCompose = `${addonsDir}/${entry.name}/compose.yml`;
      if (existsSync(addonCompose)) files.push(addonCompose);
    }
  }

  return files;
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
} {
  return {
    compose: resolveCompose(state, assets),
  };
}

// ── Artifact Metadata ──────────────────────────────────────────────────

export function buildArtifactMeta(artifacts: {
  compose: string;
}): ArtifactMeta[] {
  const now = new Date().toISOString();
  return (["compose"] as const).map((name) => ({
    name,
    sha256: sha256(artifacts[name]),
    generatedAt: now,
    bytes: Buffer.byteLength(artifacts[name])
  }));
}

// ── Channel Secrets ────────────────────────────────────────────────────

/** Load persisted CHANNEL_*_SECRET entries from vault/stack/stack.env. */
function loadPersistedChannelSecrets(vaultDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${vaultDir}/stack/stack.env`);
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
  // Write core compose to stack/
  const stackDir = `${state.homeDir}/stack`;
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(`${stackDir}/core.compose.yml`, state.artifacts.compose);

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

  // Write env schemas to vault
  ensureUserEnvSchema(assets);
  ensureSystemEnvSchema(assets);

  // Write managed.env files derived from stack spec
  const spec = readStackSpec(state.configDir);
  if (spec) {
    writeManagedEnvFiles(spec, state.vaultDir);
  }

  // Generate redact.env.schema from canonical mappings
  const systemEnv = readSystemSecretsEnvFile(state.vaultDir);
  const redactDir = `${state.dataDir}/secrets`;
  mkdirSync(redactDir, { recursive: true });
  writeFileSync(`${redactDir}/redact.env.schema`, generateRedactSchema(systemEnv));

  state.artifactMeta = buildArtifactMeta(state.artifacts);
}
