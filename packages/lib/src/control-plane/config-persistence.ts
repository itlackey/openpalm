/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to OP_HOME/data/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, chownSync, rmSync } from "node:fs";
import { errMessage } from './errors.js';
import { dirname, resolve as resolvePath } from "node:path";
import { composeConfigJsonSync, type ComposeConfigJsonResult } from "./docker.js";
import { createLogger } from "../logger.js";
import { parseEnvContent, parseEnvFile, mergeEnvContent, removeEnvKey } from './env.js';
import { ACCESS_ENV_KEYS, migrateLegacyAccessEnv, RETIRED_BIND_KEYS } from './access-toggles.js';
import { assertNoSecretLikeStackEnvKeys, isSecretLikeStackEnvKey } from './secrets.js';
import { writeSecret } from './secrets-files.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { stackEnvFile, legacyKnowledgeStackEnvFile, composeFilePath, customComposeFilePath } from "./home.js";
import { stackEnvPath } from "./paths.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { resolveOperatorIds, hasUsableOperatorId, type OperatorIds } from "./operator-ids.js";
import { STACK_DEFAULTS } from "./defaults.js";
import { SERVICE_VERSION_KEYS, VERSION_DEFAULTS } from "./versions.js";

import {
  readCoreCompose,
  readBundledStackAsset,
  readBundledCustomCompose,
} from "./core-assets.js";
export { sha256, randomHex } from "./crypto.js";
import { sha256 } from "./crypto.js";

const logger = createLogger("config-persistence");

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 *
 * Only `state/stack.env` (non-secret system config). Secret values
 * live in `knowledge/secrets/<ENV_KEY>` and are granted to services as Compose
 * file secrets. The user env (`knowledge/env/user.env`) is NOT a compose
 * env_file — it is sourced by the assistant entrypoint at container startup.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  // One file. user.env is intentionally NOT here (entrypoint-sourced; secret
  // boundary).
  return [stackEnvFile(state.homeDir)].filter(existsSync);
}

/**
 * Swap the retired default port pair before the refreshed Compose file is
 * validated. Existing fallback-generated stack.env files persisted assistant
 * port 3800 while the UI implicitly used 3810; leaving that value in place
 * would collide with the corrected UI default on 3800.
 *
 * Custom combinations retain their old effective values. If only one custom
 * port was persisted, the other old implicit default is materialized so the
 * corrected defaults do not silently move it.
 */
export function migrateLegacyDefaultPorts(homeDir: string): boolean {
  const path = legacyKnowledgeStackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const parsed = parseEnvContent(content);
  const hasAssistantPort = Object.hasOwn(parsed, "OP_ASSISTANT_PORT");
  const hasUiPort = Object.hasOwn(parsed, "OP_UI_PORT");

  const assistantPort = parsed.OP_ASSISTANT_PORT?.trim();
  const uiPort = parsed.OP_UI_PORT?.trim();
  const oldEffectiveAssistantPort = assistantPort || "3800";
  const oldEffectiveUiPort = uiPort || "3810";
  const updates: Record<string, string> = {};

  if ((!hasAssistantPort && !hasUiPort) || (oldEffectiveAssistantPort === "3800" && oldEffectiveUiPort === "3810")) {
    updates.OP_ASSISTANT_PORT = String(STACK_DEFAULTS.ports.assistant);
    updates.OP_UI_PORT = String(STACK_DEFAULTS.ports.ui);
  } else {
    if (!assistantPort) updates.OP_ASSISTANT_PORT = oldEffectiveAssistantPort;
    if (!uiPort) updates.OP_UI_PORT = oldEffectiveUiPort;
  }
  if (Object.keys(updates).length === 0) return false;

  writeFileAtomic(path, mergeEnvContent(content, updates), 0o600);
  logger.warn("Migrated default host port assignments", {
    assistant: updates.OP_ASSISTANT_PORT,
    ui: updates.OP_UI_PORT,
  });
  return true;
}

/**
 * Materialize the flat bind row for an install written under the retired
 * compose cascade, and drop the keys that cascade used.
 *
 * The cascade was `${OP_UI_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}` and
 * friends: a listener could be published purely by the ROOT variable, with no
 * per-service key in stack.env at all. The flat compose lines default straight
 * to loopback, so without this an upgraded shared-guardian install would come
 * back reachable only from the machine it runs on — the operator's paired
 * devices would simply stop connecting, with nothing in the config to explain
 * why. Runs on every deploy path beside {@link migrateLegacyDefaultPorts}.
 *
 * Exposure is preserved exactly, using the cascade's own precedence (an
 * explicit per-service key beats the root — see `readAccessToggles`). Two
 * values are DERIVED rather than copied, because the flat model makes them
 * consequences of a toggle rather than independent settings:
 *   - `GUARDIAN_DIRECT_INGRESS`, which the legacy row usually omitted, leaving
 *     a published guardian port answering 404 to everything;
 *   - `OPENCODE_AUTH`, which now tracks "is OpenCode published" exactly. A
 *     legacy row with auth on but OpenCode on loopback is relaxed to no auth
 *     on a listener nothing off-box can reach.
 */
export function migrateLegacyBindAddresses(homeDir: string): boolean {
  const path = legacyKnowledgeStackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const parsed = parseEnvContent(content);
  const retired = RETIRED_BIND_KEYS.filter((key) => Object.hasOwn(parsed, key));
  const incomplete = ACCESS_ENV_KEYS.some((key) => !parsed[key]?.trim());
  if (retired.length === 0 && !incomplete) return false;

  const migrated = migrateLegacyAccessEnv(parsed);
  let next = mergeEnvContent(content, migrated);
  for (const key of retired) next = removeEnvKey(next, key);
  if (next === content) return false;

  writeFileAtomic(path, next, 0o600);
  logger.warn("Migrated bind addresses to the flat access model", {
    retired,
    ...migrated,
  });
  return true;
}

/**
 * Write system-managed values to state/stack.env.
 *
 * Secret-like keys are NOT written here — they belong in knowledge/secrets/.
 * Use ensurePortalSecret() for portal secrets.
 */
export function writeSystemEnv(state: ControlPlaneState): void {
  const systemEnvPath = stackEnvPath(state);
  mkdirSync(`${state.stashDir}/env`, { recursive: true, mode: 0o700 });

  let base = "";
  if (existsSync(systemEnvPath)) {
    base = readFileSync(systemEnvPath, "utf-8");
  } else {
    base = generateFallbackSystemEnv(state);
  }

  // Preserve the existing OP_SETUP_COMPLETE flag as-is.
  // Only the wizard completion path (startDeploy, after health check) writes "true".
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

  const { content: strippedBase, removed } = stripSecretLikeEnvKeys(base);
  base = strippedBase;
  if (removed.length > 0) {
    // Correct per the secret-boundary contract (secrets belong in
    // knowledge/secrets/, not stack.env) — but never do it silently, and
    // never destroy the value: relocate it to knowledge/secrets/<key> (the
    // same place ensurePortalSecret/writeStackSecretEnv write to) before
    // dropping the line, then log + drop a one-time notice so the user knows
    // where it went.
    for (const { key, value } of removed) {
      writeSecret(state.homeDir, key.toLowerCase(), value.endsWith("\n") ? value : `${value}\n`);
    }
    const removedKeys = removed.map((r) => r.key);
    logger.warn("Removed secret-looking keys from stack.env; relocated values to knowledge/secrets/", {
      removedKeys,
      stackEnvPath: systemEnvPath,
    });
    recordSecretStripNotice(state, removedKeys);
  }
  assertNoSecretLikeStackEnvKeys(parseEnvContent(base));
  assertNoSecretLikeStackEnvKeys(adminManaged);

  const content = mergeEnvContent(base, adminManaged, {
    sectionHeader: "# ── Admin-managed ──────────────────────────────────────────────────"
  });

  writeFileAtomic(systemEnvPath, content, 0o600);
  chmodSync(systemEnvPath, 0o600);
}

function stripSecretLikeEnvKeys(
  content: string,
): { content: string; removed: { key: string; value: string }[] } {
  const removed: { key: string; value: string }[] = [];
  const kept = content
    .split('\n')
    .filter((line) => {
      let trimmed = line.trim();
      if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trimStart();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return true;
      const key = trimmed.slice(0, eq).trim();
      if (isSecretLikeStackEnvKey(key)) {
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        removed.push({ key, value });
        return false;
      }
      return true;
    })
    .join('\n');
  return { content: kept, removed };
}

/**
 * Path of the one-time "secret-looking values were removed from stack.env"
 * notice the UI reads and dismisses.
 */
export function secretStripNoticePath(state: ControlPlaneState): string {
  return `${state.dataDir}/secret-strip-notice.json`;
}

interface SecretStripNotice {
  keys: string[];
  at: string;
}

function recordSecretStripNotice(state: ControlPlaneState, newlyRemoved: string[]): void {
  const path = secretStripNoticePath(state);
  let keys = new Set(newlyRemoved);
  if (existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, "utf-8")) as Partial<SecretStripNotice>;
      if (Array.isArray(prior.keys)) keys = new Set([...prior.keys, ...newlyRemoved]);
    } catch {
      /* corrupt notice — overwrite with the fresh set */
    }
  }
  const notice: SecretStripNotice = { keys: [...keys].sort(), at: new Date().toISOString() };
  try {
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify(notice, null, 2));
  } catch (e) {
    logger.warn("Could not persist secret-strip notice", { error: errMessage(e) });
  }
}

/** Read the pending secret-strip notice, or null when there is none. */
export function readSecretStripNotice(state: ControlPlaneState): { keys: string[]; at: string } | null {
  const path = secretStripNoticePath(state);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SecretStripNotice>;
    if (Array.isArray(parsed.keys) && parsed.keys.length > 0 && typeof parsed.at === "string") {
      return { keys: parsed.keys, at: parsed.at };
    }
  } catch {
    /* corrupt — treat as no notice */
  }
  return null;
}

/** Dismiss (delete) the pending secret-strip notice. */
export function dismissSecretStripNotice(state: ControlPlaneState): void {
  const path = secretStripNoticePath(state);
  if (existsSync(path)) {
    try {
      rmSync(path);
    } catch (e) {
      logger.warn("Could not dismiss secret-strip notice", { error: errMessage(e) });
    }
  }
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
    "# Docker image tags (exact tag, \"latest\", or \"next\" — no semver ranges).",
    ...SERVICE_VERSION_KEYS.map((key) => `${key}=${VERSION_DEFAULTS[key]}`),
    "",
    "# ── Enabled addons (comma-separated; managed via the Add-ons UI / CLI) ──",
    "OP_ENABLED_ADDONS=",
    "",
    "# ── Ports (38XX range) ──────────────────────────────────────────────",
    "# Guardian is network-only (no host port) — portals reach it via",
    "# http://guardian:8080 over the portal_net Docker network.",
    `OP_UI_PORT=${STACK_DEFAULTS.ports.ui}`,
    `OP_ASSISTANT_PORT=${STACK_DEFAULTS.ports.assistant}`,
    `OP_HOST_UI_PORT=${STACK_DEFAULTS.ports.hostUi}`,
    ""
  ].join("\n");
}

// ── Stack Overlay Discovery ────────────────────────────────────────────

/**
 * Discover active compose overlays.
 * Returns the fixed compose stack: core, services, portals, and custom.
 * First-party services are profile-gated inside services.compose.yml and
 * portals.compose.yml.
 *
 * Host AKM sharing is NOT a compose overlay: the assistant always mounts
 * `/host-stash` (core.compose.yml, with an empty-dir fallback), and "sharing"
 * is purely a writable secondary source entry in config/akm/config.json. No
 * conditional overlay file is involved.
 */
export function discoverStackOverlays(homeDir: string): string[] {
  const files: string[] = [];

  // Managed compose (system/stack) — core first, then the fixed overlays.
  for (const name of ['core.compose.yml', 'services.compose.yml', 'portals.compose.yml']) {
    const composePath = composeFilePath(homeDir, name);
    if (existsSync(composePath)) files.push(composePath);
  }

  // User custom overlay lives in the config/ tree (not system/stack).
  const custom = customComposeFilePath(homeDir);
  if (existsSync(custom)) files.push(custom);

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

// ── Portal Secrets ────────────────────────────────────────────────────
// Defined in secrets-files.ts (so ensureSecrets can seed them without an
// import cycle); re-exported here, their long-standing public home.

export { ensurePortalSecret, portalSecretName } from './secrets-files.js';

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
  // Resolve the operator UID/GID compose runs containers as (`user:`), so we
  // can chown the dirs we pre-create to match. Without this, dirs created by
  // a root-running install (or a host UID that differs from the forced
  // container UID) are unwritable inside the non-root container — on OrbStack
  // real UIDs are preserved, so e.g. ollama's mkdir is denied (issue #452).
  const operatorIds = resolveOperatorIds(state.homeDir);

  for (const mount of discoverHomeBindMountSources(state)) {
    if (existsSync(mount.path)) continue;

    if (mount.isFile) {
      const parent = dirname(mount.path);
      mkdirSync(parent, { recursive: true });
      writeFileSync(mount.path, '');
      chownVolumeTarget(parent, operatorIds);
      chownVolumeTarget(mount.path, operatorIds);
    } else {
      mkdirSync(mount.path, { recursive: true });
      chownVolumeTarget(mount.path, operatorIds);
    }
  }
}

export function discoverHomeBindMountSources(
  state: ControlPlaneState,
  resolveConfig: (
    options: { files: string[]; envFiles?: string[] },
  ) => ComposeConfigJsonResult = composeConfigJsonSync,
): Array<{ path: string; isFile: boolean }> {
  const composeFiles = discoverStackOverlays(state.homeDir);
  if (composeFiles.length === 0) return [];

  // Docker's `compose config --format json` is the single source of truth for
  // volume/env resolution: `source` is already absolute and fully
  // `${VAR}`-interpolated (including nested `${VAR:-${VAR}}` defaults the old
  // hand-rolled regex mangled), and `type` distinguishes a host bind from a
  // named volume. Every service is included, profiled or not — `config` renders
  // profile-gated services too — so a disabled addon's dir is still pre-created
  // (issue #452). Best-effort: if compose can't resolve, skip pre-creation.
  const { ok, config, stderr } = resolveConfig({
    files: composeFiles,
    envFiles: [stackEnvPath(state)],
  });
  if (!ok || !config?.services) {
    logger.warn(`Could not resolve compose config for bind-mount pre-creation: ${stderr}`);
    return [];
  }

  const homeRoot = resolvePath(state.homeDir);
  const seen = new Set<string>();
  const mounts: Array<{ path: string; isFile: boolean }> = [];

  for (const svc of Object.values(config.services)) {
    for (const vol of svc?.volumes ?? []) {
      // Only host bind mounts point at OP_HOME paths; named volumes (`type:
      // volume`) carry a volume name, not a path.
      if (vol.type && vol.type !== 'bind') continue;
      const source = vol.source;
      if (!source?.startsWith('/')) continue;
      const resolvedHostPath = resolvePath(source);
      if (!resolvedHostPath.startsWith(`${homeRoot}/`) && resolvedHostPath !== homeRoot) continue;

      if (seen.has(resolvedHostPath)) continue;
      seen.add(resolvedHostPath);
      mounts.push({ path: resolvedHostPath, isFile: isFileMount(resolvedHostPath) });
    }
  }

  return mounts;
}

/**
 * Decide whether a bind-mount target should be pre-created as a file vs a
 * directory, from the resolved host path alone.
 *
 * Docker's resolved project view normalizes every host mount to `type: bind`
 * (short- and long-form alike), so it carries no file-vs-directory signal —
 * that distinction is inherently ours. We use a basename heuristic: a dot in
 * the basename means a file (e.g. `auth.json`, the only file mounts the shipped
 * stack declares). It is imperfect for dotted *directory* names like `data.v2`
 * (none exist in the shipped stack); prefer dotless directory names in compose
 * files to avoid relying on it.
 */
function isFileMount(resolvedHostPath: string): boolean {
  const basename = resolvedHostPath.split('/').pop() ?? '';
  return basename.includes('.');
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
      `Could not chown volume target ${path} to ${operatorIds.uid}:${operatorIds.gid}: ${errMessage(error)}`
    );
  }
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  mkdirSync(state.stackDir, { recursive: true });
  // The managed system/ tree (compose stack + system OpenCode config) is
  // overwritten wholesale from the release skeleton in applyHomeSeed
  // (overwriteSystemTree) before this runs. Here we only seed-if-absent the
  // compose files a fresh home is missing, never overwriting the managed copies.
  const composePath = `${state.stackDir}/core.compose.yml`;
  if (!existsSync(composePath)) writeFileSync(composePath, state.artifacts.compose);
  for (const name of ['services.compose.yml', 'portals.compose.yml']) {
    const path = `${state.stackDir}/${name}`;
    if (!existsSync(path)) writeFileSync(path, readBundledStackAsset(name));
  }
  const customComposePath = customComposeFilePath(state.homeDir);
  if (!existsSync(customComposePath)) {
    mkdirSync(dirname(customComposePath), { recursive: true });
    writeFileSync(customComposePath, readBundledCustomCompose());
  }

  // Write stack.env (no secrets — those live in knowledge/secrets/)
  writeSystemEnv(state);

  // Ensure state directory exists
  mkdirSync(state.dataDir, { recursive: true });

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
