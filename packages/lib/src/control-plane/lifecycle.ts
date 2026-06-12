/** Lifecycle helpers — state factory, apply transitions, compose file list. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import libPkg from "../../package.json" with { type: "json" };
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
import { ensureReleaseMigrated } from './migrations.js';
import { isSetupComplete } from "./setup-status.js";
import { snapshotCurrentState } from "./rollback.js";
import { checkDocker, composePreflight, composePull, composeUp, composeConfigServices, resolveComposeProjectName } from "./docker.js";
import { buildComposeOptions } from "./compose-args.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import type { InstallLockHandle } from "./install-lock.js";
import { getAddonServiceNames, listEnabledAddonIds } from "./registry.js";
import { compareComparableVersions, isComparableSemver, isSameMajorVersion } from "./versioning.js";
import { buildPlatformImageTagEnv, type PlatformImageTagKey } from './image-tags.js';

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLATFORM_IMAGE_NAMES = ['assistant', 'guardian', 'channel'] as const;


export function createState(): ControlPlaneState {
  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const stashDir = resolveStashDir();
  const workspaceDir = resolveWorkspaceDir();
  const dataDir = resolveDataDir();
  const stackDir = resolveStackDir();

  const withGuardian = hasEnabledChannel(listEnabledAddonIds(homeDir));
  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    // Guardian is only an expected service when a channel addon is enabled —
    // matches its deploy gating, so a no-channel install does not report it as
    // a perpetually-stopped service in the Overview/Containers status.
    if (name === "guardian" && !withGuardian) continue;
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

  return bootstrapState;
}

export function initializeStateSecrets(state: ControlPlaneState): void {
  ensureSecrets(state);
  Object.assign(process.env, readStackSecretEnv(state.stackDir));
}


async function reconcileCore(
  state: ControlPlaneState,
  opts: { activateServices?: boolean; deactivateServices?: boolean; skipSnapshot?: boolean },
): Promise<string[]> {
  if (opts.activateServices) {
    const withGuardian = hasEnabledChannel(listEnabledAddonIds(state.homeDir));
    for (const s of CORE_SERVICES) {
      if (s === "guardian" && !withGuardian) continue;
      state.services[s] = "running";
    }
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
      // List the inputs structurally — a joined shell-style command string is
      // misleading for paths with spaces and invites copy-paste execution.
      throw new Error(
        `Compose preflight failed: ${preflight.stderr}\n` +
        `Files: ${files.join(", ")}\n` +
        `Env files: ${envFiles.filter(existsSync).join(", ")}\n` +
        `Profiles: ${profiles.join(", ") || "(none)"}\n` +
        `Project: ${projectName}`
      );
    }
  }

  // Snapshot before writing (for rollback on failure). Upgrade flows skip
  // this: withStackEnvRollback already snapshotted BEFORE the new image tags
  // were written to stack.env, and re-snapshotting here would overwrite that
  // pre-upgrade state with the new (possibly broken) tags.
  if (!opts.skipSnapshot) snapshotCurrentState(state);

  // Resolve and write runtime files to live paths
  state.artifacts = resolveRuntimeFiles();
  writeRuntimeFiles(state);
  return active;
}

type LockedLifecycleOptions = { lock?: InstallLockHandle | null };

function resolveLifecycleLock(state: ControlPlaneState, opts?: LockedLifecycleOptions): InstallLockHandle | null {
  if (opts && 'lock' in opts) return opts.lock ?? null;
  return acquireInstallLock(state.dataDir);
}

function releaseLifecycleLock(lock: InstallLockHandle | null, opts?: LockedLifecycleOptions): void {
  if (opts && 'lock' in opts) return;
  releaseInstallLock(lock);
}

export async function applyInstall(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<void> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    await reconcileCore(state, { activateServices: true });
    // Pre-create host-side volume mount targets as the current user so
    // Docker doesn't create them root-owned (which causes EACCES inside
    // non-root containers).
    ensureComposeVolumeTargets(state);
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export async function applyUpdate(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<{ restarted: string[] }> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    return { restarted: await reconcileCore(state, {}) };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export async function applyUninstall(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<{ stopped: string[] }> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    return { stopped: await reconcileCore(state, { deactivateServices: true }) };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

type DockerTagEntry = { name?: unknown };
type DockerTagsResponse = { results?: unknown };

const DOCKER_REGISTRY_TIMEOUT_MS = 10_000;

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

function resolvePlatformVersionPolicyBaseTag(state: ControlPlaneState): string {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const configured = parsed.OP_IMAGE_TAG?.trim();
  if (isComparableSemver(configured)) return configured;
  return `v${libPkg.version}`;
}

function resolveNewestDockerTagForCurrentMajor(payload: unknown, currentTag: string): string | null {
  const results = (payload as DockerTagsResponse)?.results;
  if (!Array.isArray(results)) return null;

  let best: string | null = null;
  for (const entry of results as DockerTagEntry[]) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!isComparableSemver(name) || !isSameMajorVersion(name, currentTag)) continue;
    if (!best || compareComparableVersions(name, best) > 0) best = name;
  }
  return best;
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

function resolveRequiredPlatformImages(state: ControlPlaneState): string[] {
  const required = new Set<string>(['assistant']);
  if (hasEnabledChannel(listEnabledAddonIds(state.homeDir))) {
    required.add('guardian');
    required.add('channel');
  }
  return PLATFORM_IMAGE_NAMES.filter((name) => required.has(name));
}

async function isDockerImageTagPublished(namespace: string, imageName: string, tag: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(
      `https://registry.hub.docker.com/v2/repositories/${namespace}/${imageName}/tags/${tag}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(DOCKER_REGISTRY_TIMEOUT_MS) },
    );
  } catch (e) {
    throw new Error(`Failed to verify Docker image tag ${namespace}/${imageName}:${tag}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Docker tag verification failed for ${namespace}/${imageName}:${tag} (${response.status})`);
  }
  return true;
}

async function fetchDockerTagsPayload(namespace: string, imageName: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(
      `https://registry.hub.docker.com/v2/repositories/${namespace}/${imageName}/tags?page_size=25&ordering=last_updated`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(DOCKER_REGISTRY_TIMEOUT_MS) }
    );
  } catch (e) {
    throw new Error(`Failed to query Docker tags: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!response.ok) {
    throw new Error(`Docker tag lookup failed (${response.status})`);
  }

  return response.json();
}

/** Newest comparable semver tag for an image that is <= ceilingTag in the same major. */
function resolveNewestDockerTagAtOrBelow(payload: unknown, ceilingTag: string): string | null {
  const results = (payload as DockerTagsResponse)?.results;
  if (!Array.isArray(results)) return null;

  let best: string | null = null;
  for (const entry of results as DockerTagEntry[]) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!isComparableSemver(name) || !isSameMajorVersion(name, ceilingTag)) continue;
    if (compareComparableVersions(name, ceilingTag) > 0) continue;
    if (!best || compareComparableVersions(name, best) > 0) best = name;
  }
  return best;
}

/**
 * Resolve the per-image tag env for a target platform tag (#477).
 *
 * `assistant` is the version-of-record image and must be published at the
 * platform tag. Guardian/channel may lag: a release that ships only a subset
 * of images leaves them at an older tag, so each falls back to its newest
 * published tag <= the platform tag in the same major. Fail closed only when
 * a REQUIRED image (guardian/channel with a channel addon enabled) has no
 * usable tag at all.
 */
async function resolvePlatformImageTags(
  state: ControlPlaneState,
  namespace: string,
  platformTag: string,
): Promise<Record<string, string>> {
  // Non-default namespaces are local/self-built images — no Docker Hub to ask.
  if (namespace !== 'openpalm') return buildPlatformImageTagEnv(platformTag);

  if (!(await isDockerImageTagPublished(namespace, 'assistant', platformTag))) {
    throw new Error(
      `Refusing to update to ${namespace}/assistant:${platformTag}: tag is not published. ` +
      'stack.env was left unchanged.'
    );
  }

  const required = new Set(resolveRequiredPlatformImages(state));
  const perImage: Partial<Record<PlatformImageTagKey, string>> = {};
  for (const imageName of ['guardian', 'channel'] as const) {
    if (await isDockerImageTagPublished(namespace, imageName, platformTag)) continue;

    const fallbackTag = resolveNewestDockerTagAtOrBelow(
      await fetchDockerTagsPayload(namespace, imageName),
      platformTag,
    );
    if (fallbackTag) {
      perImage[`OP_${imageName.toUpperCase()}_IMAGE_TAG` as PlatformImageTagKey] = fallbackTag;
      continue;
    }
    if (required.has(imageName)) {
      throw new Error(
        `Refusing to update to ${namespace}/*:${platformTag}: no published tag found for ${imageName} ` +
        `at or below ${platformTag}. This release is incomplete for the enabled services; stack.env was left unchanged.`
      );
    }
    // Image is not deployed (no channel addon enabled) — leave it at the
    // platform tag; nothing will pull it.
  }
  return buildPlatformImageTagEnv(platformTag, perImage);
}

/**
 * Resolve the newest published platform tag from the Docker registry.
 *
 * `assistant` is the version-of-record image: its newest tag is the canonical
 * platform version. Guardian/channel may lag behind it when a release shipped
 * only a subset of images — see resolvePlatformImageTags.
 *
 * Used both to auto-detect during "Update now" and to resolve a requested
 * `latest` selection into a concrete release tag before fetching stack assets
 * (GitHub has no asset tree at a `latest` ref).
 */
export async function resolveLatestPlatformTag(namespace: string): Promise<string> {
  const latestTag = resolveNewestDockerTag(await fetchDockerTagsPayload(namespace, 'assistant'));
  if (!latestTag) {
    throw new Error("No usable Docker image tag found");
  }
  return latestTag;
}

export async function resolveLatestPlatformTagForCurrentMajor(
  namespace: string,
  currentTag: string,
): Promise<string> {
  const latestTag = resolveNewestDockerTagForCurrentMajor(
    await fetchDockerTagsPayload(namespace, 'assistant'),
    currentTag,
  );
  if (!latestTag) {
    throw new Error(`No usable Docker image tag found in major ${currentTag.replace(/^v/, '').split('.')[0]}`);
  }
  return latestTag;
}

export async function updateStackEnvToLatestImageTag(
  state: ControlPlaneState,
  resolvedTag?: string,
): Promise<{
  namespace: string;
  tag: string;
}> {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const namespace = resolveImageNamespace(state);
  const latestTag = resolvedTag ?? await resolveLatestPlatformTagForCurrentMajor(namespace, resolvePlatformVersionPolicyBaseTag(state));
  const imageTagEnv = await resolvePlatformImageTags(state, namespace, latestTag);

  const currentContent = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  const updatedContent = mergeEnvContent(currentContent, imageTagEnv);
  writeFileSync(systemEnvPath, updatedContent);

  return { namespace, tag: latestTag };
}

export async function applyUpgrade(
  state: ControlPlaneState,
  /** Release tag whose stack assets to fetch (e.g. "v0.11.0-rc.6"). Caller-supplied. */
  version: string,
  opts?: LockedLifecycleOptions,
): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    const { backupDir, updated } = await refreshCoreAssets(version);
    // skipSnapshot: the upgrade wrapper (withStackEnvRollback) snapshotted the
    // pre-upgrade state before the new image tags were written.
    const restarted = await reconcileCore(state, { skipSnapshot: true });
    return { backupDir, updated, restarted };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export type UpgradeResult = {
  imageTag: string;
  namespace: string;
  backupDir: string | null;
  assetsUpdated: string[];
  restarted: string[];
};

async function withStackEnvRollback<T>(state: ControlPlaneState, run: () => Promise<T>): Promise<T> {
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  let originalStackEnv: string | null = null;
  try {
    originalStackEnv = readFileSync(stackEnvPath, 'utf-8');
  } catch { /* stack.env may not exist yet */ }

  // Persist the PRE-upgrade state for `openpalm rollback`. Without this, the
  // snapshot taken later inside reconcileCore captures stack.env AFTER the new
  // image tags were written, so a post-crash manual rollback would "restore"
  // the broken tag.
  snapshotCurrentState(state);

  try {
    return await run();
  } catch (e) {
    if (originalStackEnv !== null) {
      try {
        writeFileSync(stackEnvPath, originalStackEnv);
      } catch { /* best effort */ }
    }
    throw e;
  }
}

/**
 * Full upgrade: resolve latest image tag, refresh assets, pull images,
 * and recreate containers. Used by both the admin endpoint and CLI.
 *
 * Callers handle their own audit logging and admin self-recreation.
 */
export async function performUpgrade(state: ControlPlaneState): Promise<UpgradeResult> {
  return withStackEnvRollback(state, async () => {
    const composeOpts = buildComposeOptions(state);

    // Compose preflight runs inside `applyUpgrade` -> `reconcileCore`, so we
    // skip the redundant top-level call. Any merge failure aborts before
    // mutation just the same.

    // 1. Update image tag + refresh core assets. Per-image publication checks
    // and fallback resolution happen inside updateStackEnvToLatestImageTag.
    const namespace = resolveImageNamespace(state);
    const imageTag = await resolveLatestPlatformTagForCurrentMajor(namespace, resolvePlatformVersionPolicyBaseTag(state));
    ensureReleaseMigrated({ homeDir: state.homeDir, targetVersion: imageTag });
    const tagResult = await updateStackEnvToLatestImageTag(state, imageTag);
    const { tag: confirmedImageTag } = tagResult;
    // The resolved platform tag IS the version whose stack assets we fetch —
    // keeps compose files and images in lockstep.
    const upgradeResult = await applyUpgrade(state, confirmedImageTag);

    // 2. Pull all images (core + addons, including profile-gated voice)
    const pullResult = await composePull(composeOpts);
    if (!pullResult.ok) {
      throw new Error(`Failed to pull images: ${pullResult.stderr}`);
    }

    // 3. Recreate containers (includes profiles for voice addon).
    // forceRecreate is REQUIRED so channel containers restart onto the newly
    // pulled baked image even when the managed compose config is unchanged.
    const services = await buildManagedServices(state);
    const upResult = await composeUp({ ...composeOpts, services, forceRecreate: true, removeOrphans: true });
    if (!upResult.ok) {
      throw new Error(`Images pulled but failed to recreate containers: ${upResult.stderr}`);
    }

    return {
      imageTag: confirmedImageTag,
      namespace,
      backupDir: upgradeResult.backupDir,
      assetsUpdated: upgradeResult.updated,
      restarted: upgradeResult.restarted,
    };
  });
}

/**
 * Set a specific image tag in stack.env then pull images and restart containers.
 * Used by the admin "set version" action — skips the auto-detect step in performUpgrade.
 */
export async function applyTagChange(state: ControlPlaneState, tag: string): Promise<UpgradeResult> {
  return withStackEnvRollback(state, async () => {
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

    const imageTagEnv = await resolvePlatformImageTags(state, namespace, resolvedTag);
    ensureReleaseMigrated({ homeDir: state.homeDir, targetVersion: resolvedTag });

    const stackEnvPath = `${state.stashDir}/env/stack.env`;
    const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
    writeFileSync(stackEnvPath, mergeEnvContent(currentContent, imageTagEnv));
    const upgradeResult = await applyUpgrade(state, resolvedTag);
    return {
      imageTag: resolvedTag,
      namespace,
      backupDir: upgradeResult.backupDir,
      assetsUpdated: upgradeResult.updated,
      restarted: upgradeResult.restarted,
    };
  });
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
  return discoverStackOverlays(state.stackDir);
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
const CHANNEL_ADDON_IDS = ["api", "chat", "discord", "slack", "gateway"];

/**
 * Guardian is channel ingress: it is both DEPLOYED and treated as an EXPECTED
 * service only when ≥1 channel addon is enabled. Single predicate so the deploy
 * set (buildManagedServices), the expected-service seed (createState), and the
 * activation loop (reconcileCore) all gate guardian identically — otherwise the
 * Overview/Containers status reports "Guardian not running" forever on a
 * no-channel install (it is never deployed). Takes the resolved addon list so
 * callers that already have it don't re-read stack.env.
 */
function hasEnabledChannel(enabledAddons: string[]): boolean {
  return enabledAddons.some((a) => CHANNEL_ADDON_IDS.includes(a));
}

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
  const services = new Set<string>(["assistant"]);
  if (hasEnabledChannel(enabledAddons)) services.add("guardian");

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
