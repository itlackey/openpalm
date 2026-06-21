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
import { ensureSecrets } from "./secrets.js";
import {
  resolveRuntimeFiles,
  writeRuntimeFiles,
  discoverStackOverlays,
  ensureComposeVolumeTargets,
} from "./config-persistence.js";
import { refreshCoreAssets } from "./core-assets.js";
import { ensureReleaseMigrated } from './migrations.js';
import { isSetupComplete } from "./setup-status.js";
import { hasArmedSnapshot, snapshotCurrentState } from "./rollback.js";
import { checkDocker, composePreflight, composePull, composeUp, composeConfigServices, resolveComposeProjectName, repairRootOwnedBindMounts } from "./docker.js";
import { buildComposeOptions } from "./compose-args.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import type { InstallLockHandle } from "./install-lock.js";
import { getAddonServiceNames, listEnabledAddonIds } from "./addons.js";
import { compareComparableVersions, isComparableSemver, isSameMajorVersion, majorVersionOf, PLATFORM_VERSION, formatForDisplay, formatForDocker, isPrerelease, normalizeVersion } from "./versioning.js";
import {
  buildPinnedImageTagEnv,
  buildPlatformImageTagEnv,
  parsePinnedImages,
  resolveEffectivePlatformImageTag,
  deployableUnitImageName,
  deployableUnitImageTagKey,
  isDeployableUnit,
  type PinnablePlatformImage,
  type PlatformImageTagKey,
  type DeployableUnit,
} from './image-tags.js';

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLATFORM_IMAGE_NAMES = ['assistant', 'guardian', 'portal'] as const;
const AUTH_TRANSITION_BOUNDARY_TAG = 'v0.12.0';


export function createState(): ControlPlaneState {
  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const stashDir = resolveStashDir();
  const workspaceDir = resolveWorkspaceDir();
  const dataDir = resolveDataDir();
  const stackDir = resolveStackDir();

  const withGuardian = hasEnabledPortal(listEnabledAddonIds(homeDir));
  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    // Guardian is only an expected service when a portal addon is enabled —
    // matches its deploy gating, so a no-portal install does not report it as
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
}


async function reconcileCore(
  state: ControlPlaneState,
  opts: { activateServices?: boolean; deactivateServices?: boolean; skipSnapshot?: boolean },
): Promise<string[]> {
  if (opts.activateServices) {
    const withGuardian = hasEnabledPortal(listEnabledAddonIds(state.homeDir));
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
  if (!opts.skipSnapshot && !hasArmedSnapshot()) snapshotCurrentState(state);

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

/**
 * Resolve the best Docker image tag from a registry tags payload.
 *
 * Constraints (all optional):
 * - `sameMajorAs`    — only consider tags whose major component matches this tag.
 * - `atOrBelow`      — only consider tags whose version is <= this tag.
 * - `skipPrerelease` — ignore prerelease tags (`-rc`, `-beta`, …). Used so a
 *                      STABLE base never auto-jumps onto a prerelease (#494),
 *                      mirroring the UI card's channel gate.
 *
 * With no constraints: returns the first semver tag found, or the first
 * non-"latest" tag as a fallback (mirrors the original resolveNewestDockerTag).
 * With constraints: returns the highest semver tag satisfying all constraints.
 */
function resolveNewestDockerTag(
  payload: unknown,
  constraints: { sameMajorAs?: string; atOrBelow?: string; skipPrerelease?: boolean } = {},
): string | null {
  const results = (payload as DockerTagsResponse)?.results;
  if (!Array.isArray(results)) return null;

  const { sameMajorAs, atOrBelow, skipPrerelease } = constraints;
  const constrained = sameMajorAs !== undefined || atOrBelow !== undefined || skipPrerelease === true;

  // Unconstrained path: return the first semver tag seen (payload is ordered
  // by last_updated), with a non-semver/non-latest fallback.
  if (!constrained) {
    let fallback: string | null = null;
    for (const entry of results as DockerTagEntry[]) {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name || name === "latest") continue;
      if (SEMVER_TAG_RE.test(name)) return name;
      if (!fallback) fallback = name;
    }
    return fallback;
  }

  // Constrained path: collect all satisfying tags and return the maximum.
  let best: string | null = null;
  for (const entry of results as DockerTagEntry[]) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!isComparableSemver(name)) continue;
    if (skipPrerelease && isPrerelease(name)) continue;
    if (sameMajorAs !== undefined && !isSameMajorVersion(name, sameMajorAs)) continue;
    if (atOrBelow !== undefined && compareComparableVersions(name, atOrBelow) > 0) continue;
    if (!best || compareComparableVersions(name, best) > 0) best = name;
  }
  return best;
}

function resolvePlatformVersionPolicyBaseTag(state: ControlPlaneState): string {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const configured = parsed.OP_IMAGE_TAG?.trim();
  if (isComparableSemver(configured)) return configured;
  return PLATFORM_VERSION;
}


/**
 * Host-vs-target guard (#492), keyed on the RUNNING control-plane version.
 *
 * The migrations a release needs live inside the @openpalm/lib that is actually
 * executing — i.e. PLATFORM_VERSION (the version of the running data/ui build, or
 * the compiled-in CLI lib). If a user points the stack at a tag NEWER than the
 * control plane they're running, `ensureReleaseMigrated` runs an OLD migration
 * array that doesn't contain that release's migrations → the new images come up
 * against half-migrated files. There is no safe recovery, so this is a HARD block
 * (not a warning): nothing is written before it throws.
 *
 * The thin-harness design (§6.5) makes this satisfiable: the supervisor self-
 * updates data/ui to the current platform BEFORE the UI serves the upgrade
 * request, so "target ≤ running platform" only fails when the user genuinely
 * picks a tag the running control plane cannot migrate to — at which point the
 * fix is to update the app / control plane first, not to proceed.
 *
 * Non-semver targets (a moving `latest`/`dev` tag) are not comparable and are
 * left to the resolver paths that turn them into a concrete release first.
 */
/**
 * Downgrade-needs-confirmation signal (#501).
 *
 * Release migrations are forward-only (copy-only, additive); they do NOT run
 * backward. Pointing the stack at an OLDER tag than the one currently running is
 * therefore a data-safety event, not a routine version change: the older images
 * may not understand files the newer release already migrated. We don't block it
 * (a user may legitimately need to roll back), but we require an explicit
 * confirmation so it can't happen by a stray dropdown selection. The UI catches
 * this by `code` and shows a plain warning + confirm; the CLI surfaces the
 * message and a `--confirm`/`--yes` path.
 */
export class DowngradeConfirmationRequired extends Error {
  readonly code = "downgrade_confirmation_required";
  readonly currentVersion: string;
  readonly targetVersion: string;
  constructor(currentVersion: string, targetVersion: string) {
    super(
      `Version ${formatForDisplay(targetVersion)} is older than the version you're running ` +
        `(${formatForDisplay(currentVersion)}). This is a downgrade. Release migrations don't run ` +
        `backward; your data may not be compatible — restore from backup if needed. ` +
        `Re-run with confirmation to proceed. Nothing was changed.`,
    );
    this.name = "DowngradeConfirmationRequired";
    this.currentVersion = currentVersion;
    this.targetVersion = targetVersion;
  }
}

/**
 * Throw {@link DowngradeConfirmationRequired} when `targetTag` is strictly older
 * than the version currently configured in stack.env, unless the caller passed
 * an explicit confirmation. Non-semver tags (a moving `latest`/`dev` ref, or a
 * first install with no current tag) are not comparable and pass through — the
 * resolver paths turn `latest` into a concrete release before this runs.
 */
function assertNotUnconfirmedDowngrade(state: ControlPlaneState, targetTag: string, confirmDowngrade: boolean): void {
  if (confirmDowngrade) return;
  const currentTag = resolvePlatformVersionPolicyBaseTag(state);
  if (!isComparableSemver(targetTag) || !isComparableSemver(currentTag)) return;
  if (compareComparableVersions(targetTag, currentTag) >= 0) return;
  throw new DowngradeConfirmationRequired(currentTag, targetTag);
}

/**
 * Convert a release git tag to a Docker image tag.
 *
 * The new per-unit release scheme uses prefixed git tags (platform-X.Y.Z,
 * portals-X.Y.Z, etc.) while Docker images always use the v-prefixed form
 * (v0.12.5). This function strips the unit prefix so applyTagChange can
 * resolve the correct Docker image tag from a GitHub release tag.
 */
function extractDockerTagFromReleaseTag(tag: string): string {
  const unitPrefixMatch = tag.match(/^(?:platform|portals|assistant|guardian)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/);
  if (unitPrefixMatch) return formatForDocker(unitPrefixMatch[1]);
  return formatForDocker(tag); // handles vX.Y.Z and bare X.Y.Z
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
  if (hasEnabledPortal(listEnabledAddonIds(state.homeDir))) {
    required.add('guardian');
    required.add('portal');
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


/**
 * Resolve the per-image tag env for a target platform tag (#477).
 *
 * `assistant` is the version-of-record image and must be published at the
 * platform tag. Guardian/portal may lag: a release that ships only a subset
 * of images leaves them at an older tag, so each falls back to its newest
 * published tag <= the platform tag in the same major. Fail closed only when
 * a required image (guardian/portal with a portal addon enabled) has no
 * usable tag at all.
 */
async function resolvePlatformImageTags(
  state: ControlPlaneState,
  namespace: string,
  platformTag: string,
  pinnedImages: PinnablePlatformImage[],
): Promise<Record<string, string>> {
  // Non-default namespaces are local/self-built images — no Docker Hub to ask.
  if (namespace !== 'openpalm') return buildPlatformImageTagEnv(platformTag, undefined, pinnedImages);

  if (!(await isDockerImageTagPublished(namespace, 'assistant', platformTag))) {
    throw new Error(
      `Refusing to update to ${namespace}/assistant:${platformTag}: tag is not published. ` +
      'stack.env was left unchanged.'
    );
  }

  const required = new Set(resolveRequiredPlatformImages(state));
  const perImage: Partial<Record<PlatformImageTagKey, string>> = {};
  for (const imageName of ['guardian', 'portal'] as const) {
    if (pinnedImages.includes(imageName)) continue;
    if (await isDockerImageTagPublished(namespace, imageName, platformTag)) continue;

    const fallbackTag = resolveNewestDockerTag(
      await fetchDockerTagsPayload(namespace, imageName),
      { sameMajorAs: platformTag, atOrBelow: platformTag },
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
    // Image is not deployed (no portal addon enabled) — leave it at the
    // platform tag; nothing will pull it.
  }
  return buildPlatformImageTagEnv(platformTag, perImage, pinnedImages);
}

function collectPinnedImageWarnings(
  currentEnv: Record<string, string>,
  pinnedImages: PinnablePlatformImage[],
  platformTag: string,
): string[] {
  if (!isComparableSemver(platformTag) || compareComparableVersions(platformTag, AUTH_TRANSITION_BOUNDARY_TAG) < 0) {
    return [];
  }

  const warnings: string[] = [];
  for (const image of pinnedImages) {
    const pinnedTag = resolveEffectivePlatformImageTag(currentEnv, image);
    if (!isComparableSemver(pinnedTag) || compareComparableVersions(pinnedTag, AUTH_TRANSITION_BOUNDARY_TAG) >= 0) {
      continue;
    }

    warnings.push(JSON.stringify({
      event: 'unsupported-cross-boundary-pin',
      service: image,
      pinnedTag,
      platformTag,
      message: `Pinned ${image} image ${pinnedTag} is older than ${AUTH_TRANSITION_BOUNDARY_TAG} while the platform tag is ${platformTag}. Mixed-auth pinning across the 0.12 boundary is unsupported.`,
    }));
  }

  return warnings;
}

/**
 * Resolve the newest published tag for a SPECIFIC image on Docker Hub.
 *
 * `assistant` is the version-of-record image, but with independently versioned
 * units each image (guardian, portal, voice) has its own release line. This
 * resolves the newest semver tag for the given image name so a per-unit update
 * check compares against the unit's own latest, not the assistant's.
 *
 * Used both to auto-detect during "Update now" and to resolve a requested
 * `latest` selection into a concrete release tag before fetching stack assets
 * (GitHub has no asset tree at a `latest` ref).
 */
export async function resolveLatestImageTag(namespace: string, imageName: string): Promise<string> {
  const latestTag = resolveNewestDockerTag(await fetchDockerTagsPayload(namespace, imageName), {});
  if (!latestTag) {
    throw new Error(`No usable Docker image tag found for ${namespace}/${imageName}`);
  }
  return latestTag;
}

/**
 * Resolve the newest published tag for a SPECIFIC image, scoped to the current
 * major version of `currentTag`. Mirrors {@link resolveLatestImageTag} with the
 * same major-scoping + prerelease policy as the platform resolver.
 */
export async function resolveLatestImageTagForCurrentMajor(
  namespace: string,
  imageName: string,
  currentTag: string,
  opts: { allowPrerelease?: boolean } = {},
): Promise<string> {
  // #494: a STABLE base must NOT auto-jump onto a prerelease (rc/beta). A
  // prerelease is always a deliberate opt-in (`openpalm update --pre`). If the
  // base is itself a prerelease, the user is already on that channel — keep it.
  const skipPrerelease = !opts.allowPrerelease && !isPrerelease(currentTag);
  const latestTag = resolveNewestDockerTag(
    await fetchDockerTagsPayload(namespace, imageName),
    { sameMajorAs: currentTag, skipPrerelease },
  );
  if (!latestTag) {
    throw new Error(`No usable Docker image tag found for ${namespace}/${imageName} in major ${majorVersionOf(currentTag) ?? currentTag}`);
  }
  return latestTag;
}

/**
 * List published Docker image tags for a SPECIFIC image, filtered + sorted.
 *
 * Mirrors {@link resolveLatestImageTag} / {@link resolveLatestImageTagForCurrentMajor}
 * but returns ALL matching tags (not just the newest), sorted newest (highest
 * semver) first. Used by the admin UI's per-unit version picker dropdowns so the
 * user can pin/rollback to any published tag — Docker Hub is the authoritative
 * source for what's available to deploy, per unit.
 *
 * Constraints (all optional):
 * - `sameMajorAs`    — only tags whose major component matches this tag.
 * - `skipPrerelease` — ignore prerelease tags (`-rc`, `-beta`, …). Default false
 *                      so the picker shows every tag on the line, including rcs.
 * - `max`            — cap the returned list (default 20).
 *
 * Tags are returned in Docker-canonical form (`v`-prefixed, as Docker Hub returns
 * them). The UI strips the `v` for display via `formatForDisplay`.
 */
export async function listDockerImageTags(
  namespace: string,
  imageName: string,
  opts: { sameMajorAs?: string; skipPrerelease?: boolean; max?: number } = {},
): Promise<string[]> {
  const { sameMajorAs, skipPrerelease = false, max = 20 } = opts;
  const payload = await fetchDockerTagsPayload(namespace, imageName);
  const results = (payload as DockerTagsResponse)?.results;
  if (!Array.isArray(results)) return [];

  const tags: string[] = [];
  for (const entry of results as DockerTagEntry[]) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name || name === 'latest') continue;
    if (!isComparableSemver(name)) continue;
    if (skipPrerelease && isPrerelease(name)) continue;
    if (sameMajorAs !== undefined && !isSameMajorVersion(name, sameMajorAs)) continue;
    tags.push(name);
  }
  tags.sort((a, b) => compareComparableVersions(b, a));
  return tags.slice(0, max);
}

/**
 * Resolve the newest published platform tag from the Docker registry.
 *
 * `assistant` is the version-of-record image: its newest tag is the canonical
 * platform version. Guardian/portal may lag behind it when a release shipped
 * only a subset of images — see resolvePlatformImageTags.
 *
 * Used both to auto-detect during "Update now" and to resolve a requested
 * `latest` selection into a concrete release tag before fetching stack assets
 * (GitHub has no asset tree at a `latest` ref).
 */
export async function resolveLatestPlatformTag(namespace: string): Promise<string> {
  return resolveLatestImageTag(namespace, 'assistant');
}

/**
 * Resolve the default target version for `openpalm migrate --dry-run`: the
 * newest published platform tag in the current major. Mirrors the resolver the
 * upgrade path uses (same namespace, same base tag, same prerelease policy) so a
 * dry-run preview reflects the exact version `openpalm update` would move to.
 */
export async function resolveDefaultMigrateTarget(
  state: ControlPlaneState,
  opts: { allowPrerelease?: boolean } = {},
): Promise<string> {
  const namespace = resolveImageNamespace(state);
  return resolveLatestPlatformTagForCurrentMajor(
    namespace,
    resolvePlatformVersionPolicyBaseTag(state),
    { allowPrerelease: opts.allowPrerelease },
  );
}

export async function resolveLatestPlatformTagForCurrentMajor(
  namespace: string,
  currentTag: string,
  opts: { allowPrerelease?: boolean } = {},
): Promise<string> {
  return resolveLatestImageTagForCurrentMajor(namespace, 'assistant', currentTag, opts);
}

export async function updateStackEnvToLatestImageTag(
  state: ControlPlaneState,
  resolvedTag?: string,
): Promise<{
  namespace: string;
  tag: string;
  warnings: string[];
}> {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  const currentEnv = parseEnvFile(systemEnvPath);
  const pinnedImages = parsePinnedImages(currentEnv.OP_PINNED_IMAGES);
  const namespace = resolveImageNamespace(state);
  const latestTag = resolvedTag ?? await resolveLatestPlatformTagForCurrentMajor(namespace, resolvePlatformVersionPolicyBaseTag(state));
  const imageTagEnv = await resolvePlatformImageTags(state, namespace, latestTag, pinnedImages);
  const pinnedImageEnv = buildPinnedImageTagEnv(currentEnv, pinnedImages);
  const warnings = collectPinnedImageWarnings(currentEnv, pinnedImages, latestTag);

  const currentContent = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  const updatedContent = mergeEnvContent(currentContent, { ...pinnedImageEnv, ...imageTagEnv });
  writeFileSync(systemEnvPath, updatedContent);

  return { namespace, tag: latestTag, warnings };
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
    // Repair any root-owned bind-mount directories before the backup runs.
    // Guardian historically ran without a `user:` directive, leaving data/guardian
    // and data/logs owned by root. The host process can't chown them directly;
    // we use a temporary Docker container with root access to fix ownership.
    await repairRootOwnedBindMounts(state.homeDir);
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
  warnings: string[];
};

async function withStackEnvRollback<T>(state: ControlPlaneState, run: () => Promise<T>): Promise<T> {
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  // Release migrations (ensureReleaseMigrated) may also write these compose files,
  // so snapshot them alongside stack.env for full rollback coverage.
  const portalsComposePath = `${state.stackDir}/portals.compose.yml`;
  const customComposePath = `${state.stackDir}/custom.compose.yml`;

  let originalStackEnv: string | null = null;
  let originalPortalsCompose: string | null = null;
  let originalCustomCompose: string | null = null;
  try {
    originalStackEnv = readFileSync(stackEnvPath, 'utf-8');
  } catch { /* stack.env may not exist yet */ }
  try {
    originalPortalsCompose = readFileSync(portalsComposePath, 'utf-8');
  } catch { /* portals.compose.yml may not exist yet */ }
  try {
    originalCustomCompose = readFileSync(customComposePath, 'utf-8');
  } catch { /* custom.compose.yml may not exist yet */ }

  // Persist the PRE-upgrade state for `openpalm rollback`. Without this, the
  // snapshot taken later inside reconcileCore captures stack.env AFTER the new
  // image tags were written, so a post-crash manual rollback would "restore"
  // the broken tag.
  snapshotCurrentState(state, { arm: true });

  try {
    return await run();
  } catch (e) {
    if (originalStackEnv !== null) {
      try {
        writeFileSync(stackEnvPath, originalStackEnv);
      } catch { /* best effort */ }
    }
    if (originalPortalsCompose !== null) {
      try {
        writeFileSync(portalsComposePath, originalPortalsCompose);
      } catch { /* best effort */ }
    }
    if (originalCustomCompose !== null) {
      try {
        writeFileSync(customComposePath, originalCustomCompose);
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
export async function performUpgrade(
  state: ControlPlaneState,
  opts: { allowPrerelease?: boolean } = {},
): Promise<UpgradeResult> {
  return withStackEnvRollback(state, async () => {
    const composeOpts = buildComposeOptions(state);

    // Compose preflight runs inside `applyUpgrade` -> `reconcileCore`, so we
    // skip the redundant top-level call. Any merge failure aborts before
    // mutation just the same.

    // 1. Update image tag + refresh core assets. Per-image publication checks
    // and fallback resolution happen inside updateStackEnvToLatestImageTag.
    const namespace = resolveImageNamespace(state);
    const imageTag = await resolveLatestPlatformTagForCurrentMajor(
      namespace,
      resolvePlatformVersionPolicyBaseTag(state),
      { allowPrerelease: opts.allowPrerelease },
    );
    ensureReleaseMigrated({ homeDir: state.homeDir, targetVersion: imageTag });
    const tagResult = await updateStackEnvToLatestImageTag(state, imageTag);
    const { tag: confirmedImageTag, warnings } = tagResult;
    // Convert the Docker image tag (v0.12.6) to the canonical git release tag
    // (platform-0.12.6) so refreshCoreAssets resolves the raw.githubusercontent URL.
    const upgradeResult = await applyUpgrade(state, 'platform-' + normalizeVersion(confirmedImageTag));

    // 2. Pull all images (core + addons, including profile-gated voice)
    const pullResult = await composePull(composeOpts);
    if (!pullResult.ok) {
      throw new Error(`Failed to pull images: ${pullResult.stderr}`);
    }

    // 3. Recreate containers (includes profiles for voice addon).
    // forceRecreate is REQUIRED so portal containers restart onto the newly
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
      warnings,
    };
  });
}

/**
 * Set a specific image tag in stack.env then pull images and restart containers.
 * Used by the admin "set version" action — skips the auto-detect step in performUpgrade.
 */
export async function applyTagChange(
  state: ControlPlaneState,
  tag: string,
  opts: { confirmDowngrade?: boolean } = {},
): Promise<UpgradeResult> {
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

    // #501: a tag OLDER than the running version is a downgrade. Forward-only
    // release migrations don't run backward, so require explicit confirmation
    // before writing anything.
    assertNotUnconfirmedDowngrade(state, resolvedTag, opts.confirmDowngrade ?? false);

    // With independently versioned units, the release git tag may carry a unit
    // prefix (platform-X.Y.Z). The Docker image tag is always v-prefixed (vX.Y.Z).
    const dockerTag = extractDockerTagFromReleaseTag(resolvedTag);

    const stackEnvPath = `${state.stashDir}/env/stack.env`;
    const currentEnv = parseEnvFile(stackEnvPath);
    const pinnedImages = parsePinnedImages(currentEnv.OP_PINNED_IMAGES);
    const imageTagEnv = await resolvePlatformImageTags(state, namespace, dockerTag, pinnedImages);
    const pinnedImageEnv = buildPinnedImageTagEnv(currentEnv, pinnedImages);
    const warnings = collectPinnedImageWarnings(currentEnv, pinnedImages, dockerTag);
    ensureReleaseMigrated({ homeDir: state.homeDir, targetVersion: resolvedTag });

    const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
    writeFileSync(stackEnvPath, mergeEnvContent(currentContent, { ...pinnedImageEnv, ...imageTagEnv }));
    // Stack assets (compose files) are downloaded using the full release tag so
    // the raw.githubusercontent fallback resolves the platform-X.Y.Z git ref.
    const upgradeResult = await applyUpgrade(state, resolvedTag);
    return {
      imageTag: dockerTag,
      namespace,
      backupDir: upgradeResult.backupDir,
      assetsUpdated: upgradeResult.updated,
      restarted: upgradeResult.restarted,
      warnings,
    };
  });
}

/**
 * Read the currently-configured image tag for a single deployable unit from
 * stack.env. Falls back to OP_IMAGE_TAG (the compose substitution fallback) and
 * finally PLATFORM_VERSION, mirroring the compose `${OP_*_IMAGE_TAG:-…}` chain.
 */
function resolveUnitCurrentTag(state: ControlPlaneState, unit: DeployableUnit): string {
  const envVars = parseEnvFile(`${state.stashDir}/env/stack.env`);
  const tag = envVars[deployableUnitImageTagKey(unit)]?.trim() || envVars.OP_IMAGE_TAG?.trim();
  if (isComparableSemver(tag)) return tag;
  return PLATFORM_VERSION;
}

/**
 * Per-unit downgrade gate (#501). A target OLDER than the unit's CURRENT tag is
 * a downgrade — forward-only release migrations don't run backward, so require
 * explicit confirmation. Compared against the unit's own tag (not the platform
 * OP_IMAGE_TAG) so pinning guardian back a patch doesn't trip on the assistant
 * version.
 */
function assertNotUnconfirmedUnitDowngrade(
  state: ControlPlaneState,
  unit: DeployableUnit,
  targetTag: string,
  confirmDowngrade: boolean,
): void {
  if (confirmDowngrade) return;
  const currentTag = resolveUnitCurrentTag(state, unit);
  if (!isComparableSemver(targetTag) || !isComparableSemver(currentTag)) return;
  if (compareComparableVersions(targetTag, currentTag) >= 0) return;
  throw new DowngradeConfirmationRequired(currentTag, targetTag);
}

/**
 * Pin a SINGLE deployable unit's image tag in stack.env, then pull + recreate.
 *
 * Unlike {@link applyTagChange} (a full platform upgrade), this writes only the
 * one `OP_*_IMAGE_TAG` env var for the named unit and does NOT run release
 * migrations or refresh stack compose assets — those are platform-level and run
 * on `performUpgrade` / `applyTagChange`. Per-unit pinning is for rolling one
 * image back to a known-good release or pinning it to a tested build without
 * moving the rest of the stack.
 *
 * Non-destructive: the write uses `mergeEnvContent` so existing user keys
 * (including commented-out ones) are preserved.
 */
export async function applyUnitImageTagChange(
  state: ControlPlaneState,
  unit: string,
  tag: string,
  opts: { confirmDowngrade?: boolean } = {},
): Promise<UpgradeResult> {
  if (!isDeployableUnit(unit)) {
    throw new Error(`Unknown deployable unit: ${unit}`);
  }
  const typedUnit = unit;
  return withStackEnvRollback(state, async () => {
    const namespace = resolveImageNamespace(state);
    const imageName = deployableUnitImageName(typedUnit);
    const envKey = deployableUnitImageTagKey(typedUnit);

    // "latest" (or an empty selection) resolves to the concrete newest tag for
    // THIS unit's image before anything is written.
    const requested = tag.trim();
    let resolvedTag = requested;
    if (requested === "" || requested.toLowerCase() === "latest") {
      try {
        resolvedTag = await resolveLatestImageTag(namespace, imageName);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Cannot resolve "latest" to a concrete release for ${typedUnit}: ${msg}. ` +
          "Check your network connection or select a specific version."
        );
      }
    }

    // #501: a tag OLDER than this unit's current tag is a downgrade.
    assertNotUnconfirmedUnitDowngrade(state, typedUnit, resolvedTag, opts.confirmDowngrade ?? false);

    const dockerTag = extractDockerTagFromReleaseTag(resolvedTag);

    // Verify publication on Docker Hub (default namespace only — local/self-built
    // images have no registry to ask). Fail closed: never write an unpublished
    // tag, the compose pull would then fail with a cryptic error.
    if (namespace === 'openpalm') {
      if (!(await isDockerImageTagPublished(namespace, imageName, dockerTag))) {
        throw new Error(
          `Refusing to pin ${namespace}/${imageName}:${dockerTag}: tag is not published. ` +
          'stack.env was left unchanged.'
        );
      }
    }

    // Non-destructive merge: write only this unit's OP_*_IMAGE_TAG. Existing
    // user keys (and commented-out ones) are preserved by mergeEnvContent.
    const stackEnvPath = `${state.stashDir}/env/stack.env`;
    const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
    writeFileSync(stackEnvPath, mergeEnvContent(currentContent, { [envKey]: dockerTag }));

    // Pull + recreate. No release migrations (platform-level) and no stack-asset
    // refresh — this is a single-image pin, not a platform upgrade.
    const composeOpts = buildComposeOptions(state);
    const pullResult = await composePull(composeOpts);
    if (!pullResult.ok) {
      throw new Error(`Failed to pull images: ${pullResult.stderr}`);
    }
    const services = await buildManagedServices(state);
    const upResult = await composeUp({ ...composeOpts, services, forceRecreate: true, removeOrphans: true });
    if (!upResult.ok) {
      throw new Error(`Images pulled but failed to recreate containers: ${upResult.stderr}`);
    }

    return {
      imageTag: dockerTag,
      namespace,
      backupDir: null,
      assetsUpdated: [],
      restarted: services,
      warnings: [],
    };
  });
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
  return discoverStackOverlays(state.stackDir);
}

// Portal addons that require the guardian ingress. Mirrors the profile gate on
// the guardian service in portals.compose.yml (profiles: addon.{chat,api,
// discord,slack}) and the built-in portal id list used in registry.ts /
// config-persistence.ts. Guardian is shared infra for these, not an addon
// service of its own (getAddonServiceNames deliberately excludes it).
//
// Deploy dependency contract (one place to read it):
//   • assistant — ALWAYS deployed; depends on nothing.
//   • guardian  — portal ingress; deployed ONLY when ≥1 portal addon is
//                 enabled; depends on assistant.
//   • portals  — each depends on guardian (compose `depends_on`), so they are
//                 never deployed without it.
// A zero-portal install therefore deploys assistant alone and must NOT
// include or health-wait on guardian. The integration test in
// guardian-gating.test.ts pins this.
const PORTAL_ADDON_IDS = ["api", "chat", "discord", "slack", "gateway"];

/**
 * Guardian is portal ingress: it is both DEPLOYED and treated as an EXPECTED
 * service only when ≥1 portal addon is enabled. Single predicate so the deploy
 * set (buildManagedServices), the expected-service seed (createState), and the
 * activation loop (reconcileCore) all gate guardian identically — otherwise the
 * Overview/Containers status reports "Guardian not running" forever on a
 * no-portal install (it is never deployed). Takes the resolved addon list so
 * callers that already have it don't re-read stack.env.
 */
function hasEnabledPortal(enabledAddons: string[]): boolean {
  return enabledAddons.some((a) => PORTAL_ADDON_IDS.includes(a));
}

export async function buildManagedServices(state: ControlPlaneState): Promise<string[]> {
  const composeOpts = buildComposeOptions(state);

  // The assistant is the only ALWAYS-on core service. The guardian is portal
  // ingress — profile-gated to the portal addons in portals.compose.yml, so
  // with zero portals enabled it is never deployed. Seeding it unconditionally
  // made the installer health-wait on a guardian that never starts (a ~5-minute
  // hang when no portal is selected). Add it back ONLY when a portal is
  // enabled; that also preserves the #450 need to force-recreate guardian on
  // upgrade when portal profiles ARE active (it is excluded from
  // getAddonServiceNames, so the fallback below would otherwise drop it).
  const enabledAddons = listEnabledAddonIds(state.homeDir);
  const services = new Set<string>(["assistant"]);
  if (hasEnabledPortal(enabledAddons)) services.add("guardian");

  // Prefer compose-derived service list when Docker is available. Resolved with
  // the active profiles, this already includes guardian iff a portal profile
  // is active — the explicit add above just guarantees it for the fallback.
  if (composeOpts.files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const result = await composeConfigServices(composeOpts);
    if (result.ok && result.services.length > 0) {
      for (const s of result.services) services.add(s);
      return [...services];
    }
  }

  // Fallback: static inference from assistant (+ guardian when portals) +
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
