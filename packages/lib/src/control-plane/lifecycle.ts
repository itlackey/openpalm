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
import { buildComposeOptions } from "./compose-args.js";
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

function resolveImageNamespace(state: ControlPlaneState): string {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const namespace = (parsed.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  if (!IMAGE_NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid image namespace in system.env: ${namespace}`);
  }
  return namespace;
}

/**
 * Resolve the newest published platform tag from the Docker registry.
 *
 * `assistant` is the version-of-record image: all platform images
 * (assistant, guardian, channel, voice) are published in lockstep under the
 * same OP_IMAGE_TAG, so its newest tag is the canonical platform version.
 *
 * Used both to auto-detect during "Update now" and to resolve a requested
 * `latest` selection into a concrete release tag before fetching stack assets
 * (GitHub has no asset tree at a `latest` ref).
 */
export async function resolveLatestPlatformTag(namespace: string): Promise<string> {
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
  return latestTag;
}

export async function updateStackEnvToLatestImageTag(state: ControlPlaneState): Promise<{
  namespace: string;
  tag: string;
}> {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const namespace = resolveImageNamespace(state);
  const latestTag = await resolveLatestPlatformTag(namespace);

  const currentContent = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  const updatedContent = mergeEnvContent(currentContent, { OP_IMAGE_TAG: latestTag }, { uncomment: true });
  writeFileSync(systemEnvPath, updatedContent);

  return { namespace, tag: latestTag };
}

export async function applyUpgrade(
  state: ControlPlaneState,
  /** Release tag whose stack assets to fetch (e.g. "v0.11.0-rc.6"). Caller-supplied. */
  version: string
): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    const { backupDir, updated } = await refreshCoreAssets(version);
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
    // The resolved platform tag IS the version whose stack assets we fetch —
    // keeps compose files and images in lockstep.
    upgradeResult = await applyUpgrade(state, imageTag);
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

  // 4. Recreate containers (includes profiles for voice addon).
  // forceRecreate is REQUIRED: channel adapters are installed at container
  // startup from npm dist-tags (CHANNEL_PACKAGE, e.g. @openpalm/channel-discord@latest),
  // so an unchanged compose config would leave those containers running on the
  // old adapter. --force-recreate guarantees guardian + channel containers
  // restart and re-resolve their dist-tag adapters (issue #450).
  const services = await buildManagedServices(state);
  const upResult = await composeUp({ ...composeOpts, services, forceRecreate: true, removeOrphans: true });
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

/**
 * Set a specific image tag in stack.env then pull images and restart containers.
 * Used by the admin "set version" action — skips the auto-detect step in performUpgrade.
 */
export async function applyTagChange(state: ControlPlaneState, tag: string): Promise<UpgradeResult> {
  const namespace = resolveImageNamespace(state);

  // "latest" (or an empty selection) is not a real GitHub ref — there are no
  // `.openpalm/...` stack assets at a `latest` tag, so refreshCoreAssets would
  // fail with a raw download error. Resolve it to the concrete newest published
  // platform tag BEFORE writing the env or fetching assets, so images and
  // stack assets stay in lockstep on a real release tag.
  const requested = tag.trim();
  let resolvedTag = requested;
  if (requested === "" || requested.toLowerCase() === "latest") {
    try {
      resolvedTag = await resolveLatestPlatformTag(namespace);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Cannot resolve "latest" to a concrete release: ${msg}. ` +
        "Check your network connection or select a specific version."
      );
    }
  }

  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
  writeFileSync(stackEnvPath, mergeEnvContent(currentContent, { OP_IMAGE_TAG: resolvedTag }, { uncomment: true }));
  const upgradeResult = await applyUpgrade(state, resolvedTag);
  return {
    imageTag: resolvedTag,
    namespace,
    backupDir: upgradeResult.backupDir,
    assetsUpdated: upgradeResult.updated,
    restarted: upgradeResult.restarted,
  };
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
  return discoverStackOverlays(state.stackDir, state.homeDir);
}

// Channel addons that require the guardian ingress. Mirrors the profile gate on
// the guardian service in channels.compose.yml (profiles: addon.{chat,api,
// discord,slack}) and the built-in channel id list used in registry.ts /
// config-persistence.ts. Guardian is shared infra for these, not an addon
// service of its own (getAddonServiceNames deliberately excludes it).
//
// Deploy dependency contract (one place to read it):
//   • assistant — ALWAYS deployed; depends on nothing.
//   • guardian  — channel ingress; deployed ONLY when ≥1 channel addon is
//                 enabled; depends on assistant.
//   • channels  — each depends on guardian (compose `depends_on`), so they are
//                 never deployed without it.
// A zero-channel install therefore deploys assistant alone and must NOT
// include or health-wait on guardian. The integration test in
// guardian-gating.test.ts pins this.
const CHANNEL_ADDON_IDS = ["api", "chat", "discord", "slack"];

export async function buildManagedServices(state: ControlPlaneState): Promise<string[]> {
  const composeOpts = buildComposeOptions(state);

  // The assistant is the only ALWAYS-on core service. The guardian is channel
  // ingress — profile-gated to the channel addons in channels.compose.yml, so
  // with zero channels enabled it is never deployed. Seeding it unconditionally
  // made the installer health-wait on a guardian that never starts (a ~5-minute
  // hang when no channel is selected). Add it back ONLY when a channel is
  // enabled; that also preserves the #450 need to force-recreate guardian on
  // upgrade when channel profiles ARE active (it is excluded from
  // getAddonServiceNames, so the fallback below would otherwise drop it).
  const enabledAddons = listEnabledAddonIds(state.homeDir);
  const channelsEnabled = enabledAddons.some((a) => CHANNEL_ADDON_IDS.includes(a));
  const services = new Set<string>(["assistant"]);
  if (channelsEnabled) services.add("guardian");

  // Prefer compose-derived service list when Docker is available. Resolved with
  // the active profiles, this already includes guardian iff a channel profile
  // is active — the explicit add above just guarantees it for the fallback.
  if (composeOpts.files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const result = await composeConfigServices(composeOpts);
    if (result.ok && result.services.length > 0) {
      for (const s of result.services) services.add(s);
      return [...services];
    }
  }

  // Fallback: static inference from assistant (+ guardian when channels) +
  // active addon overlays.
  for (const addon of enabledAddons) {
    for (const s of getAddonServiceNames(state.homeDir, addon)) services.add(s);
  }
  return [...services];
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
