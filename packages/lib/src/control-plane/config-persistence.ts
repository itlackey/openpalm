/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { isChannelAddon } from "./channels.js";
import { readStackSpec } from "./stack-spec.js";
import { writeCapabilityVars } from "./spec-to-env.js";
import { listEnabledAddonIds } from "./registry.js";

import {
  readCoreCompose,
} from "./core-assets.js";
export { sha256, randomHex } from "./crypto.js";
import { sha256, randomHex } from "./crypto.js";

const DEFAULT_IMAGE_TAG = process.env.OP_IMAGE_TAG ?? "latest";

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 * These are the live vault env files.
 *
 * Order: stack.env -> guardian.env
 *
 * Phase 2 of #388 (closes #406): `vault/user/user.env` is no longer a
 * compose env_file. User-managed env secrets live in the akm
 * `vault:user` store and are sourced by the assistant entrypoint at
 * container startup. The legacy file is migrated into akm and deleted
 * on upgrade; subsequent `docker compose` invocations must not reference
 * it (compose interpolates `${VAR}` against the merged --env-file
 * contents, and a stale user.env would shadow the akm-sourced values).
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [
    `${state.vaultDir}/stack/stack.env`,
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

export function resolveRuntimeFiles(): {
  compose: string;
} {
  return {
    compose: readCoreCompose(),
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
 */
export function readChannelSecrets(vaultDir: string): Record<string, string> {
  return extractChannelSecrets(parseEnvFile(`${vaultDir}/stack/guardian.env`));
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

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  // Write core compose to stack/
  const stackDir = `${state.homeDir}/stack`;
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(`${stackDir}/core.compose.yml`, state.artifacts.compose);

  // Load persisted channel HMAC secrets from guardian.env,
  // then generate new ones for new channel addons.
  const channelSecrets = readChannelSecrets(state.vaultDir);
  const addonStackDir = `${state.homeDir}/stack`;
  for (const addon of listEnabledAddonIds(state.homeDir)) {
    const composePath = `${addonStackDir}/addons/${addon}/compose.yml`;
    if (isChannelAddon(composePath) && !channelSecrets[addon]) {
      channelSecrets[addon] = randomHex(16);
    }
  }

  // Write channel secrets to guardian.env (the canonical source)
  writeChannelSecrets(state.vaultDir, channelSecrets);

  // Write system.env (no channel secrets — those live in guardian.env)
  writeSystemEnv(state);

  // Ensure vault directories exist (env files live under them; .env.schema
  // files have been retired — secret hygiene now lives in `akm vault`).
  mkdirSync(`${state.vaultDir}/user`, { recursive: true });
  mkdirSync(`${state.vaultDir}/stack`, { recursive: true });

  const spec = readStackSpec(state.configDir);
  // Write OP_CAP_* capability vars to stack.env from stack spec
  if (spec) {
    writeCapabilityVars(spec, state.vaultDir);
  }

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
