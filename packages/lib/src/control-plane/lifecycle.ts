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
  resolveDataDir,
  resolveStackDir,
} from "./home.js";
import { ensureSecrets, readStackSecretEnv } from "./secrets.js";
import {
  resolveRuntimeFiles,
  writeRuntimeFiles,
  discoverStackOverlays,
  ensureComposeVolumeTargets,
} from "./config-persistence.js";
import { refreshCoreAssets } from "./core-assets.js";
import { isSetupComplete } from "./setup-status.js";
import { snapshotCurrentState } from "./rollback.js";
import { checkDocker, composePreflight, composePull, composeUp, composeConfigServices, resolveComposeProjectName } from "./docker.js";
import { buildComposeOptions, writeRunScript } from "./compose-args.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { getAddonServiceNames, listEnabledAddonIds } from "./registry.js";

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;


export function createState(): ControlPlaneState {
  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const stashDir = resolveStashDir();
  const workspaceDir = resolveWorkspaceDir();
  const dataDir = resolveDataDir();
  const stackDir = resolveStackDir();

  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    services[name] = "stopped";
  }

  const bootstrapState: ControlPlaneState = {
    homeDir,
    configDir,
    stashDir,
    workspaceDir,
    dataDir,
    stackDir,
    services,
    artifacts: { compose: "" },
    artifactMeta: [],
  };

  ensureSecrets(bootstrapState);
  Object.assign(process.env, readStackSecretEnv(stackDir));

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
    mkdirSync(`${state.dataDir}/${addonName}`, { recursive: true });
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
  const { files, envFiles, profiles } = buildComposeOptions(state);
  if (files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      throw new Error(
        "Compose preflight failed: Docker is not available.\n" +
        "Docker must be running before install/update/apply operations."
      );
    }
    const preflight = await composePreflight({ files, envFiles, profiles });
    if (!preflight.ok) {
      const projectName = resolveComposeProjectName(Object.assign({}, ...envFiles.map((f) => parseEnvFile(f))));
      const fileArgs = files.flatMap((f) => ["-f", f]).join(" ");
      const envArgs = envFiles.filter(existsSync).flatMap((f) => ["--env-file", f]).join(" ");
      const profileArgs = profiles.flatMap((p) => ["--profile", p]).join(" ");
      const resolvedCmd = `docker compose ${fileArgs} --project-name ${projectName} ${envArgs} ${profileArgs} config --quiet`;
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
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    await reconcileCore(state, { activateServices: true });
    // Pre-create host-side volume mount targets as the current user so
    // Docker doesn't create them root-owned (which causes EACCES inside
    // non-root containers).
    ensureComposeVolumeTargets(state);
  } finally {
    releaseInstallLock(lock);
  }
}

export async function applyUpdate(state: ControlPlaneState): Promise<{ restarted: string[] }> {
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    return { restarted: await reconcileCore(state, {}) };
  } finally {
    releaseInstallLock(lock);
  }
}

export async function applyUninstall(state: ControlPlaneState): Promise<{ stopped: string[] }> {
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    return { stopped: await reconcileCore(state, { deactivateServices: true }) };
  } finally {
    releaseInstallLock(lock);
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
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const namespace = (parsed.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  if (!IMAGE_NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid image namespace in system.env: ${namespace}`);
  }

  // `assistant` is the version-of-record image: all platform images
  // (assistant, guardian, channel, voice) are published in lockstep under the
  // same OP_IMAGE_TAG, so its newest tag is the canonical platform version.

  let response: Response;
  try {
    response = await fetch(
      `https://registry.hub.docker.com/v2/repositories/${namespace}/assistant/tags?page_size=25&ordering=last_updated`,
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
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    const { backupDir, updated } = await refreshCoreAssets();
    const restarted = await reconcileCore(state, {});
    return { backupDir, updated, restarted };
  } finally {
    releaseInstallLock(lock);
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
  const composeOpts = buildComposeOptions(state);

  // Compose preflight runs inside `applyUpgrade` -> `reconcileCore`, so we
  // skip the redundant top-level call. Any merge failure aborts before
  // mutation just the same.

  // 1. Snapshot stack.env for rollback on failure
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
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

  // 3. Pull all images (core + addons, including profile-gated voice)
  const pullResult = await composePull(composeOpts);
  if (!pullResult.ok) {
    throw new Error(`Failed to pull images: ${pullResult.stderr}`);
  }

  // 4. Recreate containers (includes profiles for voice addon)
  const services = await buildManagedServices(state);
  const upResult = await composeUp({ ...composeOpts, services, removeOrphans: true });
  if (!upResult.ok) {
    throw new Error(`Images pulled but failed to recreate containers: ${upResult.stderr}`);
  }

  // 5. Write run.sh with the final compose command
  writeRunScript(state);

  return {
    imageTag,
    namespace,
    backupDir: upgradeResult.backupDir,
    assetsUpdated: upgradeResult.updated,
    restarted: upgradeResult.restarted,
  };
}

/**
 * Set a specific image tag in stack.env then pull images and restart containers.
 * Used by the admin "set version" action — skips the auto-detect step in performUpgrade.
 */
export async function applyTagChange(state: ControlPlaneState, tag: string): Promise<UpgradeResult> {
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
  writeFileSync(stackEnvPath, mergeEnvContent(currentContent, { OP_IMAGE_TAG: tag }, { uncomment: true }));
  const upgradeResult = await applyUpgrade(state);
  writeRunScript(state);
  return {
    imageTag: tag,
    namespace: "openpalm",
    backupDir: upgradeResult.backupDir,
    assetsUpdated: upgradeResult.updated,
    restarted: upgradeResult.restarted,
  };
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
  return discoverStackOverlays(state.stackDir, state.homeDir);
}

export async function buildManagedServices(state: ControlPlaneState): Promise<string[]> {
  const composeOpts = buildComposeOptions(state);

  // Prefer compose-derived service list when Docker is available
  if (composeOpts.files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const result = await composeConfigServices(composeOpts);
    if (result.ok && result.services.length > 0) {
      return result.services;
    }
  }

  // Fallback: static inference from CORE_SERVICES + active addon overlays
  const services: string[] = [...CORE_SERVICES];
  for (const addon of listEnabledAddonIds(state.homeDir)) {
    services.push(...getAddonServiceNames(state.homeDir, addon));
  }
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
