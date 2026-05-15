/** Lifecycle helpers — state factory, apply transitions, compose file list. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from "./env.js";
import type { ControlPlaneState, CallerType } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveStashDir,
  resolveWorkspaceDir,
  resolveCacheDir,
  resolveStateDir,
  resolveStackDir,
} from "./home.js";
import { ensureSecrets, readStackEnv, updateSystemSecretsEnv } from "./secrets.js";
import { mirrorUserVaultToAkm, migrateAndCleanupLegacyUserEnv } from "./akm-vault.js";
import {
  resolveRuntimeFiles,
  writeRuntimeFiles,
  randomHex,
  buildEnvFiles,
  discoverStackOverlays,
  ensureComposeVolumeTargets,
} from "./config-persistence.js";
import { readStackSpec } from "./stack-spec.js";
import { refreshCoreAssets } from "./core-assets.js";
import { isSetupComplete } from "./setup-status.js";
import { snapshotCurrentState } from "./rollback.js";
import { checkDocker, composePreflight, composePull, composeUp, composeConfigServices, resolveComposeProjectName } from "./docker.js";
import { acquireLock, releaseLock } from "./lock.js";
import { listEnabledAddonIds } from "./registry.js";

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;


export function createState(
  adminToken?: string
): ControlPlaneState {
  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const stashDir = resolveStashDir();
  const workspaceDir = resolveWorkspaceDir();
  const cacheDir = resolveCacheDir();
  const stateDir = resolveStateDir();
  const stackDir = resolveStackDir();

  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    services[name] = "stopped";
  }

  const setupToken = randomHex(16);
  const bootstrapState: ControlPlaneState = {
    adminToken: adminToken ?? process.env.OP_ADMIN_TOKEN ?? "",
    assistantToken: "",
    setupToken,
    homeDir,
    configDir,
    stashDir,
    workspaceDir,
    cacheDir,
    stateDir,
    stackDir,
    services,
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
  };

  ensureSecrets(bootstrapState);

  const stackEnv = readStackEnv(stateDir);
  // Precedence: explicit parameter > stack.env > process.env.
  bootstrapState.adminToken =
    adminToken
      ?? stackEnv.OP_ADMIN_TOKEN
      ?? process.env.OP_ADMIN_TOKEN
      ?? "";
  bootstrapState.assistantToken =
    stackEnv.OP_ASSISTANT_TOKEN
      ?? process.env.OP_ASSISTANT_TOKEN
      ?? "";

  // Phase 1 of #388 §B.2: state.setupToken is held in memory only.
  // Previously persisted to `${dataDir}/setup-token.txt`; that file is
  // now ephemeral. The setup wizard server owns the token lifetime
  // directly. Cross-process callers should use `${XDG_RUNTIME_DIR}`
  // (tmpfs) rather than the stash data dir.

  return bootstrapState;
}


async function reconcileCore(
  state: ControlPlaneState,
  opts: { activateServices?: boolean; deactivateServices?: boolean },
): Promise<string[]> {
  if (opts.activateServices) {
    for (const s of CORE_SERVICES) state.services[s] = "running";
  }

  for (const addonName of listEnabledAddonIds(state.homeDir)) {
    mkdirSync(`${state.stateDir}/${addonName}`, { recursive: true });
  }

  const active: string[] = [];
  for (const [name, status] of Object.entries(state.services)) {
    if (status === "running") active.push(name);
  }

  if (opts.deactivateServices) {
    for (const name of Object.keys(state.services)) state.services[name] = "stopped";
  }

  // Preflight: validate compose merge before mutation.
  // Mandatory when compose files exist and OP_SKIP_COMPOSE_PREFLIGHT is not set.
  // Fails if Docker is unavailable (Docker is required for any compose operation).
  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);
  if (files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      throw new Error(
        "Compose preflight failed: Docker is not available.\n" +
        "Docker must be running before install/update/apply operations."
      );
    }
    const preflight = await composePreflight({ files, envFiles });
    if (!preflight.ok) {
      const projectName = resolveComposeProjectName();
      const fileArgs = files.flatMap((f) => ["-f", f]).join(" ");
      const envArgs = envFiles.filter(existsSync).flatMap((f) => ["--env-file", f]).join(" ");
      const resolvedCmd = `docker compose ${fileArgs} --project-name ${projectName} ${envArgs} config --quiet`;
      throw new Error(
        `Compose preflight failed: ${preflight.stderr}\n` +
        `Resolved command: ${resolvedCmd}\n` +
        `Files: ${files.join(", ")}\n` +
        `Env files: ${envFiles.join(", ")}\n` +
        `Project: ${projectName}`
      );
    }
  }

  // Snapshot before writing (for rollback on failure)
  snapshotCurrentState(state);

  // Resolve and write runtime files to live paths
  state.artifacts = resolveRuntimeFiles();
  writeRuntimeFiles(state);
  return active;
}

export async function applyInstall(state: ControlPlaneState): Promise<void> {
  const lock = acquireLock(state.homeDir, "install");
  try {
    await reconcileCore(state, { activateServices: true });
    // Pre-create host-side volume mount targets as the current user so
    // Docker doesn't create them root-owned (which causes EACCES inside
    // non-root containers).
    ensureComposeVolumeTargets(state);
  } finally {
    releaseLock(lock);
  }
}

export async function applyUpdate(state: ControlPlaneState): Promise<{ restarted: string[] }> {
  const lock = acquireLock(state.homeDir, "update");
  try {
    return { restarted: await reconcileCore(state, {}) };
  } finally {
    releaseLock(lock);
  }
}

export async function applyUninstall(state: ControlPlaneState): Promise<{ stopped: string[] }> {
  const lock = acquireLock(state.homeDir, "uninstall");
  try {
    return { stopped: await reconcileCore(state, { deactivateServices: true }) };
  } finally {
    releaseLock(lock);
  }
}

type DockerTagEntry = { name?: unknown };
type DockerTagsResponse = { results?: unknown };

function resolveNewestDockerTag(payload: unknown): string | null {
  const results = (payload as DockerTagsResponse)?.results;
  if (!Array.isArray(results)) return null;

  let fallback: string | null = null;
  for (const entry of results as DockerTagEntry[]) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name || name === "latest") continue;
    if (SEMVER_TAG_RE.test(name)) return name;
    if (!fallback) fallback = name;
  }
  return fallback;
}

export async function updateStackEnvToLatestImageTag(state: ControlPlaneState): Promise<{
  namespace: string;
  tag: string;
}> {
  const systemEnvPath = `${state.stateDir}/stack.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const namespace = (parsed.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  if (!IMAGE_NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid image namespace in system.env: ${namespace}`);
  }

  let response: Response;
  try {
    response = await fetch(
      `https://registry.hub.docker.com/v2/repositories/${namespace}/admin/tags?page_size=25&ordering=last_updated`,
      { headers: { Accept: "application/json" } }
    );
  } catch (e) {
    throw new Error(`Failed to query Docker tags: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!response.ok) {
    throw new Error(`Docker tag lookup failed (${response.status})`);
  }

  const payload = await response.json();
  const latestTag = resolveNewestDockerTag(payload);
  if (!latestTag) {
    throw new Error("No usable Docker image tag found");
  }

  const currentContent = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  const updatedContent = mergeEnvContent(currentContent, { OP_IMAGE_TAG: latestTag }, { uncomment: true });
  writeFileSync(systemEnvPath, updatedContent);

  return { namespace, tag: latestTag };
}

export async function applyUpgrade(
  state: ControlPlaneState
): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  const lock = acquireLock(state.homeDir, "upgrade");
  try {
    const { backupDir, updated } = await refreshCoreAssets();
    const restarted = await reconcileCore(state, {});

    // Phase 2 of #388 (closes #406): migrate existing
    // `${OP_HOME}/vault/user/user.env` from pre-0.11 layouts into the
    // shared akm `vault:user` store, then delete the legacy file once
    // every key is verified present in akm. The assistant entrypoint
    // sources the akm vault directly (no compose env_file dependency on
    // user.env), so removing the file does not affect runtime env
    // resolution. Mirror + cleanup are both best-effort: the upgrade
    // succeeds on its own merits, and any akm-side error is logged so
    // the operator can re-run upgrade after fixing the akm CLI.
    await mirrorUserVaultToAkm(state).catch(() => { /* best-effort */ });
    await migrateAndCleanupLegacyUserEnv(state).catch(() => { /* best-effort */ });

    return { backupDir, updated, restarted };
  } finally {
    releaseLock(lock);
  }
}

export type UpgradeResult = {
  imageTag: string;
  namespace: string;
  backupDir: string | null;
  assetsUpdated: string[];
  restarted: string[];
};

/**
 * Full upgrade: resolve latest image tag, refresh assets, pull images,
 * and recreate containers. Used by both the admin endpoint and CLI.
 *
 * Callers handle their own audit logging and admin self-recreation.
 */
export async function performUpgrade(state: ControlPlaneState): Promise<UpgradeResult> {
  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  // Compose preflight runs inside `applyUpgrade` -> `reconcileCore`, so we
  // skip the redundant top-level call. Any merge failure aborts before
  // mutation just the same.

  // 1. Snapshot stack.env for rollback on failure
  const stackEnvPath = `${state.stateDir}/stack.env`;
  let originalStackEnv: string | null = null;
  try {
    originalStackEnv = readFileSync(stackEnvPath, "utf-8");
  } catch { /* stack.env may not exist yet */ }

  // 2. Update image tag + refresh core assets
  let imageTag: string;
  let namespace: string;
  let upgradeResult: { backupDir: string | null; updated: string[]; restarted: string[] };
  try {
    const tagResult = await updateStackEnvToLatestImageTag(state);
    imageTag = tagResult.tag;
    namespace = tagResult.namespace;
    upgradeResult = await applyUpgrade(state);
  } catch (e) {
    // Restore stack.env on failure
    if (originalStackEnv !== null) {
      try { writeFileSync(stackEnvPath, originalStackEnv); } catch { /* best effort */ }
    }
    throw e;
  }

  // 3. Pull images
  const pullResult = await composePull({ files, envFiles });
  if (!pullResult.ok) {
    throw new Error(`Failed to pull images: ${pullResult.stderr}`);
  }

  // 4. Recreate containers
  const services = await buildManagedServices(state);
  const upResult = await composeUp({ files, envFiles, services, removeOrphans: true });
  if (!upResult.ok) {
    throw new Error(`Images pulled but failed to recreate containers: ${upResult.stderr}`);
  }

  return {
    imageTag,
    namespace,
    backupDir: upgradeResult.backupDir,
    assetsUpdated: upgradeResult.updated,
    restarted: upgradeResult.restarted,
  };
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
  return discoverStackOverlays(`${state.homeDir}/stack`);
}

export async function buildManagedServices(state: ControlPlaneState): Promise<string[]> {
  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  // Prefer compose-derived service list when Docker is available
  if (files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const result = await composeConfigServices({ files, envFiles });
    if (result.ok && result.services.length > 0) {
      return result.services;
    }
  }

  // Fallback: static inference from CORE_SERVICES + active addon overlays
  const services: string[] = [...CORE_SERVICES];
  services.push(...listEnabledAddonIds(state.homeDir));
  return services;
}


const VALID_CALLERS = new Set<CallerType>([
  "assistant",
  "cli",
  "ui",
  "system",
  "test"
]);

export function normalizeCaller(headerValue: string | null): CallerType {
  const v = (headerValue ?? "").trim().toLowerCase() as CallerType;
  return VALID_CALLERS.has(v) ? v : "unknown";
}
