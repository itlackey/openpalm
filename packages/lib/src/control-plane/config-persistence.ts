/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { isChannelAddon } from "./channels.js";
import { readStackSpec, hasAddon, addonNames } from "./stack-spec.js";
import { writeCapabilityVars } from "./spec-to-env.js";

import { generateRedactSchema } from "./redact-schema.js";
import { readStackEnv } from "./secrets.js";
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
 *
 * Order: stack.env -> user.env -> guardian.env
 * guardian.env is last so channel HMAC secrets from guardian.env
 * take precedence over any stale entries in stack.env during migration.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [
    `${state.vaultDir}/stack/stack.env`,
    `${state.vaultDir}/user/user.env`,
    `${state.vaultDir}/stack/guardian.env`,
  ].filter(existsSync);
}

/**
 * Write system-managed values to vault/stack/stack.env.
 *
 * Channel HMAC secrets are NOT written here — they belong in guardian.env.
 * Use writeChannelSecrets() for channel secrets.
 */
export function writeSystemEnv(state: ControlPlaneState): void {
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
    `OP_MEMORY_PORT=3898`,
    `OP_GUARDIAN_PORT=3899`,
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
// Channel HMAC secrets live exclusively in vault/stack/guardian.env.
// Legacy stack.env entries are migrated on first writeRuntimeFiles() call.

const CHANNEL_SECRET_RE = /^CHANNEL_([A-Z0-9_]+)_SECRET$/;

/** Extract channel secrets from parsed env entries. */
function extractChannelSecrets(parsed: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const match = key.match(CHANNEL_SECRET_RE);
    if (match?.[1] && value) result[match[1].toLowerCase()] = value;
  }
  return result;
}

/**
 * Read channel HMAC secrets from vault/stack/guardian.env.
 * Falls back to vault/stack/stack.env for pre-migration installs.
 */
export function readChannelSecrets(vaultDir: string): Record<string, string> {
  const guardianPath = `${vaultDir}/stack/guardian.env`;
  const guardianSecrets = extractChannelSecrets(parseEnvFile(guardianPath));
  if (Object.keys(guardianSecrets).length > 0) return guardianSecrets;

  // Fallback: read from stack.env for pre-migration installs
  return extractChannelSecrets(parseEnvFile(`${vaultDir}/stack/stack.env`));
}

/**
 * Write channel HMAC secrets to vault/stack/guardian.env.
 * Merges with existing content; does not overwrite unrelated entries.
 */
export function writeChannelSecrets(vaultDir: string, secrets: Record<string, string>): void {
  const guardianPath = `${vaultDir}/stack/guardian.env`;
  mkdirSync(`${vaultDir}/stack`, { recursive: true });

  let base = "";
  if (existsSync(guardianPath)) {
    base = readFileSync(guardianPath, "utf-8");
  } else {
    base = "# Guardian channel HMAC secrets — managed by openpalm\n";
  }

  const updates: Record<string, string> = {};
  for (const [ch, secret] of Object.entries(secrets)) {
    updates[`CHANNEL_${ch.toUpperCase()}_SECRET`] = secret;
  }

  const content = mergeEnvContent(base, updates);
  writeFileSync(guardianPath, content, { mode: 0o600 });
  // Ensure correct permissions even if file already existed with wrong mode
  chmodSync(guardianPath, 0o600);
}

/**
 * Idempotent migration: move CHANNEL_*_SECRET entries from stack.env to guardian.env.
 * guardian.env wins on conflict (existing guardian.env entries are never overwritten).
 * Migrated entries are removed from stack.env.
 *
 * Returns the count of migrated and skipped entries.
 */
export function migrateLegacyChannelSecrets(vaultDir: string): { migrated: number; skipped: number } {
  const stackPath = `${vaultDir}/stack/stack.env`;
  if (!existsSync(stackPath)) return { migrated: 0, skipped: 0 };

  const stackContent = readFileSync(stackPath, "utf-8");
  const stackParsed = parseEnvFile(stackPath);
  const legacySecrets = extractChannelSecrets(stackParsed);
  if (Object.keys(legacySecrets).length === 0) return { migrated: 0, skipped: 0 };

  // Read existing guardian secrets
  const guardianPath = `${vaultDir}/stack/guardian.env`;
  const guardianSecrets = extractChannelSecrets(parseEnvFile(guardianPath));

  const toMigrate: Record<string, string> = {};
  let skipped = 0;
  for (const [ch, secret] of Object.entries(legacySecrets)) {
    if (guardianSecrets[ch]) {
      skipped++;
    } else {
      toMigrate[ch] = secret;
    }
  }

  // Write migrated secrets to guardian.env
  if (Object.keys(toMigrate).length > 0) {
    writeChannelSecrets(vaultDir, toMigrate);
  }

  // Remove CHANNEL_*_SECRET lines from stack.env
  const cleanedLines = stackContent.split("\n").filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return true;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return true;
    const key = trimmed.slice(0, eq).trim();
    return !CHANNEL_SECRET_RE.test(key);
  });
  writeFileSync(stackPath, cleanedLines.join("\n"));

  return { migrated: Object.keys(toMigrate).length, skipped };
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  // Write core compose to stack/
  const stackDir = `${state.homeDir}/stack`;
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(`${stackDir}/core.compose.yml`, state.artifacts.compose);

  // Migrate legacy channel secrets from stack.env to guardian.env (idempotent).
  migrateLegacyChannelSecrets(state.vaultDir);

  // Load persisted channel HMAC secrets from guardian.env (with stack.env fallback),
  // then generate new ones for new channel addons.
  const channelSecrets = readChannelSecrets(state.vaultDir);
  const spec = readStackSpec(state.configDir);
  if (spec) {
    const addonStackDir = `${state.homeDir}/stack`;
    for (const addon of addonNames(spec)) {
      const composePath = `${addonStackDir}/addons/${addon}/compose.yml`;
      if (isChannelAddon(composePath) && !channelSecrets[addon]) {
        channelSecrets[addon] = randomHex(16);
      }
    }
  }

  // Write channel secrets to guardian.env (the canonical source)
  writeChannelSecrets(state.vaultDir, channelSecrets);

  // Write system.env (no channel secrets — those live in guardian.env)
  writeSystemEnv(state);

  // Ensure env schema directories exist
  ensureUserEnvSchema();
  ensureSystemEnvSchema();

  // Write OP_CAP_* capability vars to stack.env from stack spec
  const specForEnv = spec ?? readStackSpec(state.configDir);
  if (specForEnv) {
    writeCapabilityVars(specForEnv, state.vaultDir);
  }

  // Generate redact.env.schema from canonical mappings
  const systemEnv = readStackEnv(state.vaultDir);
  const redactDir = `${state.dataDir}/secrets`;
  mkdirSync(redactDir, { recursive: true });
  writeFileSync(`${redactDir}/redact.env.schema`, generateRedactSchema(systemEnv));

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
