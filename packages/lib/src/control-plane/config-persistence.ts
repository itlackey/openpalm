/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { isChannelAddon } from "./channels.js";
import { readStackSpec, hasAddon, addonNames } from "./stack-spec.js";
import { writeManagedEnvFiles } from "./spec-to-env.js";

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

function resolveCompose(_state: ControlPlaneState): string {
  return readCoreCompose();
}

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 * These are the live vault env files.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  // managed.env is NOT included here — it's loaded at service level in
  // core.compose.yml (memory service only). Global --env-file would leak
  // memory-specific vars to all services.
  return [
    `${state.vaultDir}/stack/stack.env`,
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
    `OP_ADMIN_TOKEN=\${OP_ADMIN_TOKEN}`,
    `OP_ASSISTANT_TOKEN=\${OP_ASSISTANT_TOKEN}`,
    "",
    "# ── Service Auth ─────────────────────────────────────────────────────",
    `OP_MEMORY_TOKEN=${process.env.OP_MEMORY_TOKEN ?? ""}`,
    "OP_OPENCODE_PASSWORD=",
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

// ── Top-Level Operations ─────────────────────────────────────────────

export function resolveRuntimeFiles(
  state: ControlPlaneState
): {
  compose: string;
} {
  return {
    compose: resolveCompose(state),
  };
}

// ── Runtime File Metadata ──────────────────────────────────────────────

export function buildRuntimeFileMeta(artifacts: {
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

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  // Write core compose to stack/
  const stackDir = `${state.homeDir}/stack`;
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(`${stackDir}/core.compose.yml`, state.artifacts.compose);

  // Load persisted channel HMAC secrets, generate new ones for new channels.
  // Only generate secrets for addons that are enabled in stack.yaml AND are
  // channel addons (have CHANNEL_NAME/GUARDIAN_URL in their compose).
  const channelSecrets = loadPersistedChannelSecrets(state.vaultDir);
  const spec = readStackSpec(state.configDir);
  if (spec) {
    const stackDir = `${state.homeDir}/stack`;
    for (const addon of addonNames(spec)) {
      const composePath = `${stackDir}/addons/${addon}/compose.yml`;
      if (isChannelAddon(composePath) && !channelSecrets[addon]) {
        channelSecrets[addon] = randomHex(16);
      }
    }
  }

  // Write system.env with channel secrets and system values
  writeSystemEnv(state, channelSecrets);

  // Ensure env schema directories exist
  ensureUserEnvSchema();
  ensureSystemEnvSchema();

  // Write managed.env files derived from stack spec
  const specForEnv = spec ?? readStackSpec(state.configDir);
  if (specForEnv) {
    writeManagedEnvFiles(specForEnv, state.vaultDir);
  }

  // Generate redact.env.schema from canonical mappings
  const systemEnv = readSystemSecretsEnvFile(state.vaultDir);
  const redactDir = `${state.dataDir}/secrets`;
  mkdirSync(redactDir, { recursive: true });
  writeFileSync(`${redactDir}/redact.env.schema`, generateRedactSchema(systemEnv));

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
