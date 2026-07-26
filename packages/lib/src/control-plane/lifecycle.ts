/** Lifecycle helpers — state factory, apply transitions, compose file list. */
import { mkdirSync } from "node:fs";
import type { ControlPlaneState, CallerType } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveStashDir,
  resolveWorkspaceDir,
  resolveDataDir,
  resolveStackDir,
  ensureHomeDirs,
} from "./home.js";
import { ensureSecrets, ensureOpenCodeConfig } from "./secrets.js";
import { runHomeMigrations } from "./home-schema.js";
import {
  resolveRuntimeFiles,
  writeRuntimeFiles,
  discoverStackOverlays,
  ensureComposeVolumeTargets,
} from "./config-persistence.js";
import { ensureOpenCodeSystemConfig } from "./core-assets.js";
import { applyHomeSeed } from "./ui-assets.js";
import { restoreSnapshot, snapshotCurrentState } from "./rollback.js";
import { checkDocker, composePreflight, applyStack, composeConfigServices, buildComposePreflightError } from "./docker.js";
import { reconcileHostOwnership } from "./ownership-reconcile.js";
import { buildComposeOptions } from "./compose-args.js";
import { teardownRenamedProject } from "./project-rename.js";
import { checkCustomComposeChannelLan } from "./overlay-deprecations.js";
import { createLogger } from "../logger.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import type { InstallLockHandle } from "./install-lock.js";
import {
  getAddonServiceNames,
  listEnabledAddonIds,
  pruneRemovedAddonState,
} from "./addons.js";
import { GUARDIAN_INGRESS_ADDON_IDS } from "./addon-ids.js";
import { PLATFORM_VERSION } from "./versioning.js";
import { ensureVersionDefaults } from "./versions.js";

const lifecycleLogger = createLogger("lifecycle");
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
  opts: { activateServices?: boolean; deactivateServices?: boolean },
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

  // Validate the refreshed compose merge before writing runtime files or touching containers.
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

  // Resolve and write runtime files to live paths
  state.artifacts = resolveRuntimeFiles();
  writeRuntimeFiles(state);
  return active;
}

/**
 * Bring an OP_HOME's assets to the running platform version — the "apply" half
 * of the single install==update path (constitution §1, §3, §4).
 *
 * Ownership is by top-level tree, so the write policy follows the destination.
 * Every step is idempotent:
 *   • ensureHomeDirs        — create the OP_HOME directory layout
 *   • ensureSecrets         — generate any missing service secrets
 *   • applyHomeSeed       — overwrite the managed system/ tree wholesale +
 *                             seed the user/data trees once (skip-existing)
 *   • ensureOpenCode*       — starter OpenCode config + data dir (seed-if-missing)
 *
 * This is the ONLY function that writes OP_HOME's layout/assets, so callers never
 * need to defensively re-ensure dirs or config themselves.
 */
async function applyHome(state: ControlPlaneState): Promise<void> {
  ensureHomeDirs();
  // Migrations run FIRST, before anything else reads or writes the layout.
  // ensureSecrets bootstraps state/stack.env with OP_SETUP_COMPLETE=false when
  // the file is absent, which on a pre-consolidation home is every time — so
  // running it first left the migration merging a stub over the operator's real
  // state and reporting a completed install as unconfigured.
  runHomeMigrations(state.homeDir);
  ensureSecrets(state);
  await applyHomeSeed(PLATFORM_VERSION, state.homeDir, state.configDir, state.dataDir);
  pruneRemovedAddonState(state.homeDir);
  ensureVersionDefaults(state);
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
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

async function applyManagedFiles(
  state: ControlPlaneState,
  activateServices = false,
): Promise<void> {
  const overlayCheck = checkCustomComposeChannelLan(state.homeDir);
  if (overlayCheck.blockError) throw new Error(overlayCheck.blockError);
  if (overlayCheck.warning) lifecycleLogger.warn(overlayCheck.warning);

  // Migrate BEFORE snapshotting: on a pre-consolidation home the snapshot
  // list's state/stack.env does not exist yet, so snapshotting first would
  // capture no stack env at all and a failed deploy could not roll back env
  // mutations. The migration is value-preserving, so the snapshot still
  // records the pre-update values — just in the canonical location.
  runHomeMigrations(state.homeDir);
  snapshotCurrentState(state);
  await applyHome(state);
  await reconcileCore(state, { activateServices });
}

async function reapplyRestoredStack(state: ControlPlaneState): Promise<void> {
  const result = await applyStack(
    { kind: "all" },
    buildComposeOptions(state),
    undefined,
    { pull: "missing" },
  );
  if (!result.ok) throw new Error(result.error ?? "Failed to reapply restored stack");
}

export async function restoreSnapshotAndApplyStack(state: ControlPlaneState): Promise<void> {
  restoreSnapshot(state);
  await reapplyRestoredStack(state);
}

async function runWithSnapshotRollback(
  state: ControlPlaneState,
  run: () => Promise<void>,
  shouldReapplyStack: boolean | (() => boolean) = false,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    let restored = false;
    try {
      restoreSnapshot(state);
      restored = true;
    } catch (restoreError) {
      lifecycleLogger.error("failed to restore lifecycle snapshot", {
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
    }
    const reapplyStack = typeof shouldReapplyStack === "function"
      ? shouldReapplyStack()
      : shouldReapplyStack;
    if (restored && reapplyStack) {
      try {
        await reapplyRestoredStack(state);
      } catch (reapplyError) {
        lifecycleLogger.error("failed to reapply restored stack", {
          error: reapplyError instanceof Error ? reapplyError.message : String(reapplyError),
        });
      }
    }
    throw error;
  }
}

export async function applyInstall(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<void> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    await runWithSnapshotRollback(state, async () => {
      await applyManagedFiles(state, true);
      ensureComposeVolumeTargets(state);
    });
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export async function applyUpdate(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<void> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    await runWithSnapshotRollback(state, () => applyManagedFiles(state));
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

export async function applyUninstall(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<{ stopped: string[] }> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  try {
    const active = await reconcileCore(state, { deactivateServices: true });
    return { stopped: active };
  } finally {
    releaseLifecycleLock(lock, opts);
  }
}

/** Refresh managed files, pull every active image, then apply the stack once. */
export async function performUpgrade(state: ControlPlaneState, opts?: LockedLifecycleOptions): Promise<void> {
  const lock = resolveLifecycleLock(state, opts);
  if (!lock) throw new Error("Another install is already in progress");
  let containersMutated = false;
  try {
    await runWithSnapshotRollback(state, async () => {
      await reconcileHostOwnership(state, { services: await buildManagedServices(state) });
      await applyManagedFiles(state, true);

      const renameTeardown = await teardownRenamedProject(state);
      if (renameTeardown.warning) lifecycleLogger.warn(renameTeardown.warning);
      if (renameTeardown.downed) containersMutated = true;
      if (renameTeardown.blocked) {
        throw new Error(renameTeardown.warning ?? "Project rename teardown failed.");
      }

      const result = await applyStack(
        { kind: "all" },
        buildComposeOptions(state),
        undefined,
        { pull: "always" },
      );
      if (!result.ok) {
        containersMutated = containersMutated || result.pullFailed !== true;
        throw new Error(result.error ?? "Failed to apply stack");
      }
    }, () => containersMutated);
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
