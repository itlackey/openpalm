/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to ~/.cache/openpalm/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { parse as yamlParse } from "yaml";
import { parseEnvFile, mergeEnvContent, expandEnvVars } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { isChannelAddon } from "./channels.js";
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
    `${state.stackDir}/guardian.env`,
  ].filter(existsSync);
}

/**
 * Write system-managed values to config/stack/stack.env.
 *
 * Channel HMAC secrets are NOT written here — they belong in guardian.env.
 * Use writeChannelSecrets() for channel secrets.
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
    `OP_UI_LOGIN_PASSWORD=\${OP_UI_LOGIN_PASSWORD}`,
    "",
    "# ── Service Auth ─────────────────────────────────────────────────────",
    "OP_OPENCODE_PASSWORD=",
    "",
    "# ── Paths ──────────────────────────────────────────────────────────",
    `OP_HOME=${state.homeDir}`,
    `OP_UID=${uid}`,
    `OP_GID=${gid}`,
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
 * Read channel HMAC secrets from config/stack/guardian.env.
 */
export function readChannelSecrets(stackDir: string): Record<string, string> {
  return extractChannelSecrets(parseEnvFile(`${stackDir}/guardian.env`));
}

/**
 * Write channel HMAC secrets to state/guardian.env.
 * Merges with existing content; does not overwrite unrelated entries.
 */
export function writeChannelSecrets(stackDir: string, secrets: Record<string, string>): void {
  const guardianPath = `${stackDir}/guardian.env`;
  mkdirSync(stackDir, { recursive: true });

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

// ── Volume Mount Targets ───────────────────────────────────────────────

/**
 * Parse all enabled compose files and pre-create every host-side volume
 * mount target as the current user. This prevents Docker from creating
 * them as root-owned, which causes EACCES inside non-root containers.
 *
 * For file mounts (basename contains a `.`), creates an empty file.
 * For directory mounts (basename has no `.`), creates the directory.
 *
 * Heuristic: a basename containing a `.` is treated as a file. This
 * intentionally includes leading-dot files (e.g. `.env`) because Docker
 * bind mounts to them must be regular files. Bare directory names like
 * `stack` or `addons` lack extensions and are created as directories.
 *
 * Only mount sources under `state.homeDir` are touched; external paths
 * (e.g. `/var/run/docker.sock`) are left alone.
 */
export function ensureComposeVolumeTargets(state: ControlPlaneState): void {
  const composeFiles = discoverStackOverlays(`${state.homeDir}/stack`);
  if (composeFiles.length === 0) return;

  const envVars: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...parseEnvFile(`${state.stackDir}/stack.env`),
  };

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
        if (existsSync(hostPath)) continue;

        // A basename containing a `.` (anywhere, including leading) is a file.
        // Bare names like `stack` or `data` are directories.
        const basename = hostPath.split('/').pop() ?? '';
        const isFile = basename.includes('.');

        if (isFile) {
          mkdirSync(dirname(hostPath), { recursive: true });
          writeFileSync(hostPath, '');
        } else {
          mkdirSync(hostPath, { recursive: true });
        }
      }
    }
  }
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  // Write core compose to config/stack/
  mkdirSync(state.stackDir, { recursive: true });
  writeFileSync(`${state.stackDir}/core.compose.yml`, state.artifacts.compose);

  // Load persisted channel HMAC secrets from guardian.env,
  // then generate new ones for new channel addons.
  const channelSecrets = readChannelSecrets(state.stackDir);
  for (const addon of listEnabledAddonIds(state.homeDir)) {
    const composePath = `${state.stackDir}/addons/${addon}/compose.yml`;
    if (isChannelAddon(composePath) && !channelSecrets[addon]) {
      channelSecrets[addon] = randomHex(16);
    }
  }

  // Write channel secrets to guardian.env (the canonical source)
  writeChannelSecrets(state.stackDir, channelSecrets);

  // Write system.env (no channel secrets — those live in guardian.env)
  writeSystemEnv(state);

  // Ensure state directory exists
  mkdirSync(state.stateDir, { recursive: true });

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
