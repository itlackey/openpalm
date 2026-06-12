/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to OP_HOME/data/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, chownSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as yamlParse } from "yaml";
import { createLogger } from "../logger.js";
import { parseEnvContent, parseEnvFile, mergeEnvContent, expandEnvVars } from './env.js';
import { assertNoSecretLikeStackEnvKeys, isSecretLikeStackEnvKey } from './secrets.js';
import { ensureSecret } from './secrets-files.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { listEnabledAddonIds } from "./registry.js";
import { resolveOperatorIds, hasUsableOperatorId, type OperatorIds } from "./operator-ids.js";
import { STACK_DEFAULTS } from "./defaults.js";
import { CURRENT_LAYOUT_VERSION } from "./migrations.js";
import { buildPlatformImageTagEnv } from './image-tags.js';

import {
  readCoreCompose,
  readBundledStackAsset,
  refreshCoreAssetsFromSource,
} from "./core-assets.js";
export { sha256, randomHex } from "./crypto.js";
import { sha256, randomHex } from "./crypto.js";

export const DEFAULT_IMAGE_TAG = "latest";

const logger = createLogger("config-persistence");

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 *
 * Only `knowledge/env/stack.env` (non-secret system config). Secret values
 * live in `knowledge/secrets/<ENV_KEY>` and are granted to services as Compose
 * file secrets. The user env (`knowledge/env/user.env`) is NOT a compose
 * env_file — it is sourced by the assistant entrypoint at container startup.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [
    `${state.stashDir}/env/stack.env`,
  ].filter(existsSync);
}

/**
 * Write system-managed values to knowledge/env/stack.env.
 *
 * Secret-like keys are NOT written here — they belong in knowledge/secrets/.
 * Use ensureChannelSecret() for channel secrets.
 */
export function writeSystemEnv(state: ControlPlaneState): void {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  mkdirSync(`${state.stashDir}/env`, { recursive: true, mode: 0o700 });

  let base = "";
  if (existsSync(systemEnvPath)) {
    base = readFileSync(systemEnvPath, "utf-8");
  } else {
    base = generateFallbackSystemEnv(state);
  }

  // Preserve the existing OP_SETUP_COMPLETE flag as-is.
  // Only the wizard completion path (buildSystemSecretsFromSetup) writes "true".
  // Defaulting to "false" here ensures a fresh install always shows the wizard.
  const parsed = parseEnvFile(systemEnvPath);
  const adminManaged: Record<string, string> = {
    OP_SETUP_COMPLETE: parsed.OP_SETUP_COMPLETE === "true" ? "true" : "false",
  };

  // Backfill OP_UID/OP_GID when the existing stack.env was written by an
  // older code path that hard-coded 1000, or when the file was created
  // with missing/zero values. We only override when the current value is
  // missing or zero — an operator who manually set OP_UID=2000 (e.g.
  // because they're running on a host with a non-1000 service account)
  // must not be silently changed.
  const ids = resolveOperatorIds(state.homeDir);
  if (ids) {
    if (!hasUsableOperatorId(parsed, "OP_UID")) adminManaged.OP_UID = String(ids.uid);
    if (!hasUsableOperatorId(parsed, "OP_GID")) adminManaged.OP_GID = String(ids.gid);
  }

  // Backfill OP_HOME when missing — compose files reference ${OP_HOME}
  // for all volume mounts. Without this, Docker Compose defaults to blank.
  if (!parsed.OP_HOME) adminManaged.OP_HOME = state.homeDir;

  base = stripSecretLikeEnvKeys(base);
  assertNoSecretLikeStackEnvKeys(parseEnvContent(base));
  assertNoSecretLikeStackEnvKeys(adminManaged);

  const content = mergeEnvContent(base, adminManaged, {
    sectionHeader: "# ── Admin-managed ──────────────────────────────────────────────────"
  });

  writeFileSync(systemEnvPath, content, { mode: 0o600 });
  chmodSync(systemEnvPath, 0o600);
}

function stripSecretLikeEnvKeys(content: string): string {
  return content
    .split('\n')
    .filter((line) => {
      let trimmed = line.trim();
      if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trimStart();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return true;
      return !isSecretLikeStackEnvKey(trimmed.slice(0, eq).trim());
    })
    .join('\n');
}

function generateFallbackSystemEnv(state: ControlPlaneState): string {
  // Operator UID/GID — auto-detect from OP_HOME owner (or process UID).
  // Skipped on Windows where containers run in WSL2 and OP_UID has no
  // meaning on the host process.
  const ids = resolveOperatorIds(state.homeDir);
  const idLines: string[] = ids
    ? [`OP_UID=${ids.uid}`, `OP_GID=${ids.gid}`]
    : [];

  return [
    "# OpenPalm — System Configuration (managed by CLI/admin)",
    "# Auto-generated fallback.",
    "",
    "# ── Paths ──────────────────────────────────────────────────────────",
    `OP_HOME=${state.homeDir}`,
    ...idLines,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OP_IMAGE_NAMESPACE=${process.env.OP_IMAGE_NAMESPACE ?? "openpalm"}`,
    ...Object.entries(buildPlatformImageTagEnv(DEFAULT_IMAGE_TAG)).map(([key, value]) => `${key}=${value}`),
    "",
    "# ── Layout (on-disk schema version; managed by the migration harness) ──",
    `OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`,
    "",
    "# ── Enabled addons (comma-separated; managed via the Add-ons UI / CLI) ──",
    "OP_ENABLED_ADDONS=",
    "",
    "# ── Ports (38XX range) ──────────────────────────────────────────────",
    "# Guardian is network-only (no host port) — portals reach it via",
    "# http://guardian:8080 over the portal_net Docker network.",
    `OP_ASSISTANT_PORT=${STACK_DEFAULTS.ports.assistant}`,
    `OP_HOST_UI_PORT=${STACK_DEFAULTS.ports.hostUi}`,
    ""
  ].join("\n");
}

// ── Stack Overlay Discovery ────────────────────────────────────────────

/**
 * Discover active compose overlays.
 * Returns the fixed compose stack: core, services, channels, and custom.
 * First-party services are profile-gated inside services.compose.yml and
 * channels.compose.yml.
 *
 * Host AKM sharing is NOT a compose overlay: the assistant always mounts
 * `/host-stash` (core.compose.yml, with an empty-dir fallback), and "sharing"
 * is purely a writable secondary source entry in config/akm/config.json. No
 * conditional overlay file is involved.
 */
export function discoverStackOverlays(stackDir: string): string[] {
  const files: string[] = [];

  const coreYml = `${stackDir}/core.compose.yml`;
  if (existsSync(coreYml)) files.push(coreYml);

  for (const name of ['services.compose.yml', 'channels.compose.yml', 'custom.compose.yml']) {
    const composePath = `${stackDir}/${name}`;
    if (existsSync(composePath)) files.push(composePath);
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

export function channelSecretName(addon: string): string {
  return `channel_${addon.replace(/-/g, '_')}_secret`;
}

export function ensureChannelSecret(stackDir: string, addon: string): string {
  return ensureSecret(stackDir, channelSecretName(addon), () => randomHex(16));
}

// ── Volume Mount Targets ───────────────────────────────────────────────

/**
 * Parse enabled compose files and pre-create host-side volume mount
 * targets under OP_HOME as the current user. This prevents Docker from
 * creating them as root-owned, which causes EACCES inside non-root
 * containers.
 *
 * Only mount sources under `state.homeDir` are touched; external paths
 * (e.g. `/var/run/docker.sock`) are left alone.
 *
 * The file-vs-directory distinction is best-effort and only applies to
 * explicit OP_HOME paths.
 */
export function ensureComposeVolumeTargets(state: ControlPlaneState): void {
  const composeFiles = discoverStackOverlays(state.stackDir);
  if (composeFiles.length === 0) return;

  // Resolve the operator UID/GID compose runs containers as (`user:`), so we
  // can chown the dirs we pre-create to match. Without this, dirs created by
  // a root-running install (or a host UID that differs from the forced
  // container UID) are unwritable inside the non-root container — on OrbStack
  // real UIDs are preserved, so e.g. ollama's mkdir is denied (issue #452).
  const operatorIds = resolveOperatorIds(state.homeDir);

  const envVars: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...parseEnvFile(`${state.stashDir}/env/stack.env`),
  };
  const homeRoot = resolvePath(state.homeDir);

  for (const file of composeFiles) {
    let doc: Record<string, unknown>;
    try {
      doc = yamlParse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const services = doc?.services;
    if (!services || typeof services !== 'object') continue;

    for (const svc of Object.values(services as Record<string, unknown>)) {
      if (!svc || typeof svc !== 'object') continue;
      const svcRecord = svc as Record<string, unknown>;
      if (!Array.isArray(svcRecord.volumes)) continue;
      for (const vol of svcRecord.volumes as unknown[]) {
        const volRecord = typeof vol === 'object' && vol !== null
          ? (vol as Record<string, unknown>)
          : null;
        const rawSource = typeof vol === 'string'
          ? vol.split(':')[0]
          : String(volRecord?.source ?? '');
        if (!rawSource) continue;

        const hostPath = expandEnvVars(rawSource, envVars);
        if (!hostPath || !hostPath.startsWith('/')) continue;
        const resolvedHostPath = resolvePath(hostPath);
        if (!resolvedHostPath.startsWith(`${homeRoot}/`) && resolvedHostPath !== homeRoot) continue;
        if (existsSync(resolvedHostPath)) continue;

        // Only create mounts under OP_HOME. For now, treat existing explicit
        // file paths as files and directory paths as directories.
        const basename = resolvedHostPath.split('/').pop() ?? '';
        const isFile = basename.includes('.');

        if (isFile) {
          const parent = dirname(resolvedHostPath);
          mkdirSync(parent, { recursive: true });
          writeFileSync(resolvedHostPath, '');
          chownVolumeTarget(parent, operatorIds);
          chownVolumeTarget(resolvedHostPath, operatorIds);
        } else {
          mkdirSync(resolvedHostPath, { recursive: true });
          chownVolumeTarget(resolvedHostPath, operatorIds);
        }
      }
    }
  }
}

/**
 * chown a just-created bind-mount target to the operator UID/GID so the
 * non-root container (`user: ${OP_UID}:${OP_GID}`) can write to it.
 *
 * No-op on Windows (chown is meaningless there) or when no operator can be
 * resolved. A failure (e.g. not the owner) is logged and swallowed — the
 * mkdir already succeeded and Docker Desktop's gRPC-FUSE masks ownership
 * anyway, so a chown failure must not abort the install.
 */
function chownVolumeTarget(path: string, operatorIds: OperatorIds | null): void {
  if (process.platform === "win32" || !operatorIds) return;
  try {
    chownSync(path, operatorIds.uid, operatorIds.gid);
  } catch (error) {
    logger.warn(
      `Could not chown volume target ${path} to ${operatorIds.uid}:${operatorIds.gid}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  mkdirSync(state.stackDir, { recursive: true });
  const managedSourceRoot = `${state.homeDir}/.openpalm`;
  if (existsSync(`${managedSourceRoot}/config/stack/core.compose.yml`)) {
    refreshCoreAssetsFromSource(managedSourceRoot, state.homeDir);
  }
  const composePath = `${state.stackDir}/core.compose.yml`;
  if (!existsSync(composePath)) writeFileSync(composePath, state.artifacts.compose);
  for (const name of ['services.compose.yml', 'channels.compose.yml']) {
    const path = `${state.stackDir}/${name}`;
    if (!existsSync(path)) writeFileSync(path, readBundledStackAsset(name));
  }
  const customComposePath = `${state.stackDir}/custom.compose.yml`;
  if (!existsSync(customComposePath)) writeFileSync(customComposePath, readBundledStackAsset('custom.compose.yml'));

  for (const addon of listEnabledAddonIds(state.homeDir)) {
    if (['api', 'chat', 'discord', 'slack'].includes(addon)) {
      for (const channel of ['api', 'chat', 'discord', 'slack']) {
        ensureChannelSecret(state.stackDir, channel);
      }
      break;
    }
  }

  // Write stack.env (no secrets — those live in knowledge/secrets/)
  writeSystemEnv(state);

  // Ensure state directory exists
  mkdirSync(state.dataDir, { recursive: true });

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
