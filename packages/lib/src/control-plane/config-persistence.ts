/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as yamlParse } from "yaml";
import { parseEnvContent, parseEnvFile, mergeEnvContent, expandEnvVars } from './env.js';
import { assertNoSecretLikeStackEnvKeys, isSecretLikeStackEnvKey } from './secrets.js';
import { ensureSecret } from './secrets-files.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { isChannelAddon } from "./channels.js";
import { listEnabledAddonIds } from "./registry.js";
import { resolveOperatorIds, hasUsableOperatorId } from "./operator-ids.js";

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
 * Order: stack.env. Secret values live in stash/vaults/secrets/<ENV_KEY>
 * and are loaded explicitly by the services/control plane that need them.
 *
 * Note: `vault/user/user.env` is no longer a
 * compose env_file. User-managed env secrets live in the akm
 * `vault:user` store and are sourced by the assistant entrypoint at
 * container startup. The legacy file is migrated into akm and deleted
 * on upgrade; subsequent `docker compose` invocations must not reference
 * it (compose interpolates `${VAR}` against the merged --env-file
 * contents, and a stale user.env would shadow the akm-sourced values).
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [
    `${state.stackDir}/stack.env`,
  ].filter(existsSync);
}

/**
 * Write system-managed values to config/stack/stack.env.
 *
 * Secret-like keys are NOT written here — they belong in stash/vaults/secrets/.
 * Use ensureChannelSecret() for channel secrets.
 */
export function writeSystemEnv(state: ControlPlaneState): void {
  mkdirSync(state.stackDir, { recursive: true });

  const systemEnvPath = `${state.stackDir}/stack.env`;

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
    `OP_IMAGE_TAG=${DEFAULT_IMAGE_TAG}`,
    "",
    "# ── Ports (38XX range) ──────────────────────────────────────────────",
    "# Guardian is network-only (no host port) — channels reach it via",
    "# http://guardian:8080 over the channel_lan Docker network.",
    `OP_ASSISTANT_PORT=3800`,
    `OP_ADMIN_PORT=3880`,
    `OP_ADMIN_OPENCODE_PORT=3881`,
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
      const dir = `${addonsDir}/${entry.name}`;
      // Pick up compose.yml plus any compose.<variant>.yml sibling
      // overlays (e.g. compose.cdi.yml generated by /admin/voice on
      // CDI hosts). Stable sort: compose.yml first, then siblings
      // alphabetically, so the base file's keys are the defaults and
      // overlays merge on top in deterministic order.
      const overlays = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /^compose(\.[A-Za-z0-9_-]+)?\.ya?ml$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => {
          if (a === "compose.yml" || a === "compose.yaml") return -1;
          if (b === "compose.yml" || b === "compose.yaml") return 1;
          return a.localeCompare(b);
        });
      for (const name of overlays) files.push(`${dir}/${name}`);
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

  const envVars: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...parseEnvFile(`${state.stackDir}/stack.env`),
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
          mkdirSync(dirname(resolvedHostPath), { recursive: true });
          writeFileSync(resolvedHostPath, '');
        } else {
          mkdirSync(resolvedHostPath, { recursive: true });
        }
      }
    }
  }
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  // Write core compose to config/stack/ only on first install —
  // refreshCoreAssets() is the canonical writer on update.
  mkdirSync(state.stackDir, { recursive: true });
  const composePath = `${state.stackDir}/core.compose.yml`;
  if (!existsSync(composePath)) {
    writeFileSync(composePath, state.artifacts.compose);
  }

  for (const addon of listEnabledAddonIds(state.homeDir)) {
    const composePath = `${state.stackDir}/addons/${addon}/compose.yml`;
    if (isChannelAddon(composePath)) {
      ensureChannelSecret(state.stackDir, addon);
    }
  }

  // Write stack.env (no secrets — those live in stash/vaults/secrets/)
  writeSystemEnv(state);

  // Ensure state directory exists
  mkdirSync(state.stateDir, { recursive: true });

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
