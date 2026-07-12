/** Lifecycle helpers — state factory, apply transitions, compose file list. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnvFile } from "./env.js";
import type { ControlPlaneState, CallerType } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveStashDir,
  resolveWorkspaceDir,
  resolveDataDir,
  resolveStackDir,
  customComposeFilePath,
  stateEnvFile,
  ensureHomeDirs,
} from "./home.js";
import { ensureSecrets, ensureOpenCodeConfig } from "./secrets.js";
import {
  resolveRuntimeFiles,
  writeRuntimeFiles,
  discoverStackOverlays,
  ensureComposeVolumeTargets,
} from "./config-persistence.js";
import { ensureOpenCodeSystemConfig } from "./core-assets.js";
import { applyHomeSeed } from "./ui-assets.js";
import { hasArmedSnapshot, snapshotCurrentState, clearArmedSnapshot } from "./rollback.js";
import { checkDocker, composePreflight, applyStack, composeConfigServices, buildComposePreflightError } from "./docker.js";
import { reconcileHostOwnership } from "./ownership-reconcile.js";
import { buildComposeOptions } from "./compose-args.js";
import { teardownRenamedProject } from "./project-rename.js";
import { checkCustomComposeChannelLan } from "./overlay-deprecations.js";
import { createLogger } from "../logger.js";

const lifecycleLogger = createLogger("lifecycle");
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import type { InstallLockHandle } from "./install-lock.js";
import { getAddonServiceNames, listEnabledAddonIds, migrateProfileOnlyAddonEnablement, pruneRemovedAddonState } from "./addons.js";
import { GUARDIAN_INGRESS_ADDON_IDS } from "./addon-ids.js";
import { PLATFORM_VERSION, formatForDisplay } from "./versioning.js";
import { stackEnvPath } from "./paths.js";

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;


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
      throw new Error(buildComposePreflightError({ files, envFiles, profiles }, preflight.stderr));
    }
  }

  // Snapshot before writing (for rollback on failure). Upgrade flows skip
  // this: performUpgrade already snapshotted BEFORE refreshing assets, and
  // re-snapshotting here would overwrite that pre-upgrade state.
  if (!opts.skipSnapshot && !hasArmedSnapshot()) snapshotCurrentState(state);

  // Resolve and write runtime files to live paths
  state.artifacts = resolveRuntimeFiles();
  writeRuntimeFiles(state);
  return active;
}

/**
 * Bring an OP_HOME's assets to the running platform version — the "apply" half
 * of the single install==update path (constitution §1, §3, §4).
 *
 * There is no reconcile/migration phase: ownership is by top-level tree, so the
 * write policy follows the destination. Every step is idempotent:
 *   • ensureHomeDirs        — create the OP_HOME directory layout
 *   • ensureSecrets         — generate any missing service secrets
 *   • applyHomeSeed       — overwrite the managed system/ tree wholesale +
 *                             seed the user/data trees once (skip-existing)
 *   • ensureOpenCode*       — starter OpenCode config + data dir (seed-if-missing)
 *
 * This is the ONLY function that writes OP_HOME's layout/assets, so callers never
 * need to defensively re-ensure dirs or config themselves.
 *
 * Returns the managed assets it actually overwrote and the backup dir created
 * for any changed managed file, so performUpgrade can surface them in
 * UpgradeResult — the upgrade route logs the asset list and shows the backup dir.
 */
async function applyHome(
  state: ControlPlaneState,
): Promise<{ assetsUpdated: string[]; backupDir: string | null }> {
  ensureHomeDirs();
  ensureSecrets(state);
  // Strip stale state for addons that no longer exist (e.g. `ssh`, removed on
  // the rootless branch). Idempotent no-op when clean; runs on every reconcile
  // so an upgraded install self-heals without the user touching an addon.
  pruneRemovedAddonState(state.homeDir);
  // One-time upgrade guard (2.2): persist any addon enablement that today only
  // exists as a derived OP_VOICE_PROFILE/OP_OLLAMA_PROFILE reverse-parse, so it
  // survives once that reverse-parse is eventually removed. Idempotent no-op
  // once migrated.
  migrateProfileOnlyAddonEnablement(state.homeDir);
  const seed = await applyHomeSeed(PLATFORM_VERSION, state.homeDir, state.configDir, state.dataDir);
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  return { assetsUpdated: seed.updated, backupDir: seed.backupDir };
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

/**
 * The four lifecycle operations, as a discriminated union. Each entry point
 * constructs exactly one; there is no way to name an illegal mix of steps.
 * `reconcileStack` derives its exact reconcile steps straight from `kind`
 * (see the inline `activate`/`deactivate`/`composes` derivation below) —
 * there used to be a separate `planLifecycleOp` flag-table function here, but
 * only ONE of the four kinds ("upgrade") ever composed, so the table added a
 * layer of indirection over what is really a single `kind === "upgrade"`
 * check (plan 2.2 — deleted rather than kept as dead ceremony).
 */
export type LifecycleOp =
  | { kind: "install" }
  | { kind: "update" }
  | { kind: "uninstall" }
  | { kind: "upgrade" };

/**
 * The single idempotent stack reconcile. Every lifecycle entry point is a thin
 * variant of this, selected by LifecycleOp `kind`:
 *   1. applyHome       — bring OP_HOME assets up to PLATFORM_VERSION (overwrite
 *                        the managed system/ tree, seed user/data once). No GitHub.
 *   2. reconcileCore   — preflight, snapshot (rollback), write runtime files,
 *                        flip service state per activate/deactivate.
 *   3. applyStack      — (upgrade only) the single compose driver (§4.3):
 *                        ONE `up --pull missing --force-recreate` call, fatal
 *                        only when a pinned image is genuinely missing.
 *
 * `install`/`update`/`uninstall` never compose here: those consumers
 * (runDeploy, the admin install/update/uninstall routes) already own a
 * bespoke compose phase via applyStack directly — letting the wrapper apply
 * the stack too would (a) double-recreate and (b) on a fresh install fatally
 * `up` BEFORE the route has finished writing config. `upgrade` (CLI `openpalm
 * update`, the admin upgrade route) is the ONLY kind whose consumers have no
 * separate compose phase and want the full apply to happen here, with
 * rollback on failure.
 *
 * The whole thing runs under withStackEnvRollback: stack.env + the portals/custom
 * compose files are snapshotted and restored if any step throws, and the
 * pre-reconcile state is armed for `openpalm rollback`. reconcileCore runs with
 * skipSnapshot:true so it never takes a second snapshot over that armed one.
 *
 * Returns the services that were active (running) after the reconcile — the
 * "restarted" set for update/upgrade reporting — plus the OP_HOME assets it
 * changed and any backup dir a release migration created, for UpgradeResult.
 */
function reconcileStack(
  state: ControlPlaneState,
  op: LifecycleOp,
): Promise<{ active: string[]; assetsUpdated: string[]; backupDir: string | null; warnings: string[] }> {
  const activate = op.kind === "install" || op.kind === "upgrade";
  const deactivate = op.kind === "uninstall";
  const composes = op.kind === "upgrade";

  // Overlay deprecation guard (#490): runs BEFORE withStackEnvRollback arms the
  // pre-reconcile snapshot and BEFORE applyHome can overwrite core.compose.yml
  // (core.compose.yml is not in the crash-restore set). A custom.compose.yml
  // that still references the removed `channel_lan` network without defining
  // it itself would otherwise fail later with a cryptic Docker error, AFTER
  // managed files were already overwritten. Fail fast instead, while nothing
  // has changed yet.
  const overlayCheck = checkCustomComposeChannelLan(state.homeDir);
  // PR #564 r3566892768: only BLOCK on activation (install/upgrade), where
  // applyHome overwrites managed compose and a later channel_lan reference
  // would fail cryptically. uninstall/update must never be blocked by a
  // deprecated overlay reference — the operator must always be able to tear
  // down or update. The warning still fires for every op kind (informational).
  if (overlayCheck.blockError && activate) throw new Error(overlayCheck.blockError);
  if (overlayCheck.warning) lifecycleLogger.warn(overlayCheck.warning);

  return withStackEnvRollback(state, async () => {
    // Activation flows (install/update/upgrade) may recreate containers; the
    // deactivation flow (uninstall) only rewrites runtime files reflecting the
    // stopped state — the route does composeDown. Gate the container-touching
    // work on activation so uninstall stays a pure file/state reconcile.
    const activating = !deactivate;

    const home = await applyHome(state);

    // Host-ownership reconcile AFTER applyHome (R9 S6 Gap B) — the repair-path
    // list is derived from the managed compose files on disk
    // (ownershipRepairPaths -> discoverHomeBindMountSources), which are only
    // guaranteed current once applyHome has written/refreshed them. Running
    // this before applyHome under-reports mount sources on a partially-
    // migrated home (crash mid-migration, or a first upgrade from a
    // pre-`system/stack` layout), and the repair marker then suppresses any
    // later, complete repair. Still runs BEFORE writing runtime files /
    // recreating containers — the SAME shared lib step `openpalm start` runs,
    // so UI/electron upgrades get host-swap detection, the deep bind-mount +
    // named-volume ownership repair, and the identity record (R2).
    // Pre-rootless containers ran as root, leaving bind-mount trees + named
    // volumes owned by root; the host process can't chown them directly, so a
    // temporary root Docker container fixes ownership. No adopt flag here
    // (the UI has none): an un-adopted host swap throws HostSwapBlockedError,
    // which withStackEnvRollback surfaces to the route.
    if (activating && composes) {
      const managedServices = await buildManagedServices(state);
      await reconcileHostOwnership(state, { services: managedServices });
    }

    // skipSnapshot: withStackEnvRollback already armed the pre-reconcile snapshot.
    const active = await reconcileCore(state, {
      activateServices: activate,
      deactivateServices: deactivate,
      skipSnapshot: true,
    });

    if (activating && composes) {
      // Project rename (#540): stop the recorded outgoing project before the
      // stack comes up under the new name, or the old containers keep running
      // (and holding host ports) unaddressable by any further compose call.
      // A blocked teardown aborts the upgrade — continuing would bring up a
      // second stack colliding with the still-running old project.
      const renameTeardown = await teardownRenamedProject(state);
      if (renameTeardown.warning) lifecycleLogger.warn(renameTeardown.warning);
      if (renameTeardown.blocked) {
        throw new Error(renameTeardown.warning ?? 'Project rename teardown failed.');
      }
      if (renameTeardown.downed) {
        lifecycleLogger.info(`project rename: stopped previous docker project "${renameTeardown.downed}"`);
      }

      // The single compose driver (§4.3, plan 2.2): ONE `up --pull missing
      // --force-recreate --remove-orphans` call. --force-recreate is REQUIRED
      // so portal containers restart onto a newly pulled baked image even
      // when the managed compose config is unchanged (#450). Named-volume
      // ownership was already repaired by reconcileHostOwnership above.
      const composeOpts = buildComposeOptions(state);
      const result = await applyStack({ kind: "all" }, composeOpts);
      if (!result.ok) {
        throw new Error(`Failed to apply stack: ${result.error ?? "unknown error"}`);
      }
    }

    return {
      active,
      assetsUpdated: home.assetsUpdated,
      backupDir: home.backupDir,
      warnings: overlayCheck.warning ? [overlayCheck.warning] : [],
    };
  });
}

export async function applyInstall(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<void> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    await reconcileStack(state, { kind: "install" });
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
    // No activate flag: an update reconciles assets + runtime files and reports
    // the already-running set, preserving each service's prior running/stopped
    // state (matching HEAD's reconcileCore(state, {}) semantics). It must NOT
    // force-mark a deliberately-stopped core service as running. The route drives
    // the actual recreate from buildManagedServices; `restarted` is for reporting.
    const { active } = await reconcileStack(state, { kind: "update" });
    return { restarted: active };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export async function applyUninstall(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<{ stopped: string[] }> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    const { active } = await reconcileStack(state, { kind: "uninstall" });
    return { stopped: active };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

/**
 * Downgrade-needs-confirmation signal (#501).
 *
 * Release migrations are forward-only (copy-only, additive); they do NOT run
 * backward. Pointing the stack at an OLDER release than the one currently
 * running is therefore a data-safety event, not a routine version change: the
 * older images may not understand files the newer release already migrated. We
 * don't block it (a user may legitimately need to roll back), but we require an
 * explicit confirmation so it can't happen by accident. The UI catches this by
 * `code` and shows a plain warning + confirm; the CLI surfaces the message and a
 * `--confirm`/`--yes` path.
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

function resolveImageNamespace(state: ControlPlaneState): string {
  const systemEnvPath = stackEnvPath(state);
  const parsed = parseEnvFile(systemEnvPath);
  const namespace = (parsed.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  if (!IMAGE_NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid image namespace in system.env: ${namespace}`);
  }
  return namespace;
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
  const stackEnvFile = stackEnvPath(state);
  // applyHome may overwrite these managed compose files from the skeleton, so
  // snapshot them alongside stack.env for full rollback coverage.
  const portalsComposePath = `${state.stackDir}/portals.compose.yml`;
  const customComposePath = customComposeFilePath(state.homeDir);
  // state/stack.state.env is merged OVER the legacy stack.env and wins the
  // compose merge (readStackEnv) — a crash-restore that reverted stack.env but
  // left a migrated state.state.env in place would restore an inconsistent mix.
  // Scope note (intentionally NOT unified with SNAPSHOT_FILES in rollback.ts):
  // this in-memory set is the crash-restore scope (what a single lifecycle op
  // can touch); SNAPSHOT_FILES is the manual-rollback scope (also covers
  // services.compose.yml, core.compose.yml, auth.json backup).
  const stateEnvPathValue = stateEnvFile(state.homeDir);

  let originalStackEnv: string | null = null;
  let originalPortalsCompose: string | null = null;
  let originalCustomCompose: string | null = null;
  let originalStateEnv: string | null = null;
  try {
    originalStackEnv = readFileSync(stackEnvFile, 'utf-8');
  } catch { /* stack.env may not exist yet */ }
  try {
    originalPortalsCompose = readFileSync(portalsComposePath, 'utf-8');
  } catch { /* portals.compose.yml may not exist yet */ }
  try {
    originalCustomCompose = readFileSync(customComposePath, 'utf-8');
  } catch { /* custom.compose.yml may not exist yet */ }
  try {
    originalStateEnv = readFileSync(stateEnvPathValue, 'utf-8');
  } catch { /* state.state.env may not exist yet */ }

  // Persist the PRE-reconcile state for `openpalm rollback`. Without this, the
  // snapshot taken later inside reconcileCore captures stack.env AFTER the
  // release migrations ran, so a post-crash manual rollback would "restore" the
  // already-migrated state.
  //
  // Guard on hasArmedSnapshot(): an armed snapshot that already exists is a
  // PRE-EXISTING pre-operation snapshot from an earlier lifecycle run that
  // crashed before it could roll back or clear its arm. Re-arming here would
  // overwrite it with the CURRENT (post-crash, partially-changed) state, so a
  // later `openpalm rollback` would restore the wrong (broken) state. Preserve
  // the existing armed snapshot; only arm a fresh one when none is armed.
  // reconcileCore runs with skipSnapshot:true, so this is the only arm point.
  if (!hasArmedSnapshot()) snapshotCurrentState(state, { arm: true });

  try {
    const result = await run();
    // Disarm on success: without this, hasArmedSnapshot() above stays true
    // forever after the very first lifecycle op, so every later successful op
    // preserves the original (day-one) armed snapshot instead of taking a
    // fresh pre-op one. `openpalm rollback` would then always restore day-one
    // state instead of the immediately-preceding operation's state (X1).
    clearArmedSnapshot();
    return result;
  } catch (e) {
    if (originalStackEnv !== null) {
      try {
        writeFileSync(stackEnvFile, originalStackEnv);
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
    if (originalStateEnv !== null) {
      try {
        writeFileSync(stateEnvPathValue, originalStateEnv);
      } catch { /* best effort */ }
    }
    throw e;
  }
}

/**
 * Update the stack to the running control-plane version: run forward release
 * migrations, refresh core stack assets (compose/config) for PLATFORM_VERSION,
 * then pull images and recreate containers honoring the per-image OP_*_VERSION
 * pins already written in stack.env.
 *
 * There are NO Docker Hub calls: image versions are user-managed in stack.env
 * (PATCH /api/host/versions), and the platform asset version is the running lib's
 * PLATFORM_VERSION — never resolved from a remote registry.
 *
 * `allowPrerelease` is accepted for caller intent/forward-compatibility but is
 * currently a NO-OP: there is no remote-tag resolution to gate, since the target
 * is always the running PLATFORM_VERSION and image tags are user-pinned in
 * stack.env. Forward-only release migrations decide compatibility (a downgrade
 * target yields no pending migrations rather than throwing). Callers pass it so
 * the gate can be wired here later without an API change.
 */
export async function performUpgrade(
  state: ControlPlaneState,
  opts?: LockedLifecycleOptions & { allowPrerelease?: boolean },
): Promise<UpgradeResult> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    // The asset version is the running control plane's own version — the data/ui
    // build self-updates to the current platform before serving the request, so
    // PLATFORM_VERSION is authoritative. OP_HOME asset application (overwrite the
    // managed system/ tree + seed user/data once) happens inside reconcileStack
    // via applyHome; there are NO GitHub/registry calls — image versions are
    // user-managed in stack.env (PATCH /api/host/versions).
    const namespace = resolveImageNamespace(state);

    // compose+pull: fetch each image from its OP_*_VERSION pin, then recreate
    // containers (including profile-gated voice). performUpgrade is the only
    // wrapper that drives compose itself — its consumers (CLI update, the admin
    // upgrade route) have no separate compose phase. withStackEnvRollback inside
    // reconcileStack restores stack.env + compose overlays if any step throws.
    const { active, assetsUpdated, backupDir, warnings } = await reconcileStack(state, { kind: "upgrade" });

    return {
      // The published Docker image is tagged with the bare version (0.12.41+);
      // PLATFORM_VERSION is already bare, so report it directly.
      imageTag: PLATFORM_VERSION,
      namespace,
      backupDir,
      assetsUpdated,
      restarted: active,
      warnings,
    };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
  return discoverStackOverlays(state.homeDir);
}

// Guardian is shared ingress for these addons, not an addon service of its own
// (getAddonServiceNames deliberately excludes it). The id set lives in
// addon-ids.ts (GUARDIAN_INGRESS_ADDON_IDS) and mirrors the profile gate on the
// guardian service in portals.compose.yml.
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
  return enabledAddons.some((a) => GUARDIAN_INGRESS_ADDON_IDS.includes(a));
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
