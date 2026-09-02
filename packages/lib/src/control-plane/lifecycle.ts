/** Lifecycle helpers — state factory, apply transitions, compose file list. */
import { mkdirSync } from 'node:fs';
import type { ControlPlaneState, CallerType } from './types.js';
import { MANAGED_SERVICES } from './types.js';
import {
	resolveOpenPalmHome,
	resolveConfigDir,
	resolveStashDir,
	resolveWorkspaceDir,
	resolveDataDir,
	resolveStackDir,
	ensureHomeDirs
} from './home.js';
import { ensureSecrets, ensureOpenCodeConfig, readStackEnv } from './secrets.js';
import { runHomeMigrations } from './home-schema.js';
import { reconcileRemoteAccess } from './remote-apply.js';
import {
	resolveRuntimeFiles,
	writeRuntimeFiles,
	discoverStackOverlays,
	ensureComposeVolumeTargets,
	ensureHostPortDefaults
} from './config-persistence.js';
import { ensureOpenCodeSystemConfig } from './core-assets.js';
import { applyHomeSeed, readSkeletonVersion } from './ui-assets.js';
import { restoreSnapshot, snapshotCurrentState } from './rollback.js';
import {
	applyStack,
	checkDocker,
	composePreflight,
	composeConfigServices,
	buildComposePreflightError
} from './docker.js';
import { activateStack } from './activation.js';
import {
	checkLifecycleDiskHeadroom,
	describeLifecycleDiskHeadroom,
	shouldBlockOnDiskHeadroom
} from './disk-headroom.js';
import { reapAndLogRetiredVolumes } from './image-volume-retention.js';
import { reconcileHostOwnership } from './ownership-reconcile.js';
import { buildComposeOptions } from './compose-args.js';
import { teardownRenamedProject } from './project-rename.js';
import { checkCustomComposeChannelLan } from './overlay-deprecations.js';
import { createLogger } from '../logger.js';
import { acquireInstallLock, releaseInstallLock } from './install-lock.js';
import type { InstallLockHandle } from './install-lock.js';
import { getAddonServiceNames, listEnabledAddonIds, pruneRemovedAddonState } from './addons.js';
import { backupOpenPalmHome, pruneBackupDirs } from './backup.js';
import { guardianRequired } from './guardian-required.js';
import { advanceManagedImageVersions, assertHomeNotNewerThanApp, ensureVersionDefaults } from './versions.js';
import { reconcileAkmDbJournalMode } from './akm-db-journal.js';
import {
	captureRunningImageIds,
	restoreRunningImageIds,
	type RunningImageSnapshot
} from './image-snapshots.js';

const lifecycleLogger = createLogger('lifecycle');
export function createState(): ControlPlaneState {
	const homeDir = resolveOpenPalmHome();
	const configDir = resolveConfigDir();
	const stashDir = resolveStashDir();
	const workspaceDir = resolveWorkspaceDir();
	const dataDir = resolveDataDir();
	const stackDir = resolveStackDir();

	const withGuardian = guardianRequired(homeDir);
	const services: Record<string, 'running' | 'stopped'> = {};
	for (const name of MANAGED_SERVICES) {
		// Guardian is only expected when a guardian-ingress addon is enabled, so
		// an Assistant-only install does not report it as perpetually stopped.
		if (name === 'guardian' && !withGuardian) continue;
		services[name] = 'stopped';
	}

	const bootstrapState: ControlPlaneState = {
		homeDir,
		configDir,
		stashDir,
		workspaceDir,
		dataDir,
		stackDir,
		services,
		artifacts: { compose: '' },
		artifactMeta: []
	};

	return bootstrapState;
}

export function initializeStateSecrets(state: ControlPlaneState): void {
	ensureSecrets(state);
}

async function reconcileCore(
	state: ControlPlaneState,
	opts: { activateServices?: boolean; deactivateServices?: boolean }
): Promise<string[]> {
	if (opts.activateServices) {
		const withGuardian = guardianRequired(state.homeDir);
		for (const s of MANAGED_SERVICES) {
			if (s === 'guardian' && !withGuardian) continue;
			state.services[s] = 'running';
		}
	}

	for (const addonName of listEnabledAddonIds(state.homeDir)) {
		mkdirSync(`${state.dataDir}/${addonName}`, { recursive: true });
	}

	const active: string[] = [];
	for (const [name, status] of Object.entries(state.services)) {
		if (status === 'running') active.push(name);
	}

	if (opts.deactivateServices) {
		for (const name of Object.keys(state.services)) state.services[name] = 'stopped';
	}

	// Validate the refreshed compose merge before writing runtime files or touching containers.
	// Mandatory when compose files exist and OP_SKIP_COMPOSE_PREFLIGHT is not set.
	// Fails if Docker is unavailable (Docker is required for any compose operation).
	const { files, envFiles, profiles } = buildComposeOptions(state);
	if (files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
		// S6: one preflight, two checks. The CLI runs this same pair in
		// cli-compose.ts for day-2 commands; doing it HERE too is what covers the
		// UI-driven install/update/apply paths, which reach compose through this
		// function and otherwise had no disk guard at all — the exact restart/
		// install feedback loop that filled the disk in the #581 incident.
		// Non-fatal by default: warns unless OP_DISK_HARD_BLOCK=1 AND critical.
		// #588: measures Docker's data root too when that is a separate filesystem
		// — image pulls land there, not in OP_HOME, so an "ok" OP_HOME alone was
		// never evidence the pull would fit. Reports whichever is more severe;
		// falls back to the OP_HOME reading alone if Docker can't be asked.
		const headroom = await checkLifecycleDiskHeadroom(state.homeDir);
		const headroomWarning = describeLifecycleDiskHeadroom(headroom);
		if (headroomWarning) {
			if (shouldBlockOnDiskHeadroom(headroom.worst)) throw new Error(headroomWarning);
			lifecycleLogger.warn(headroomWarning);
		}

		const dockerCheck = await checkDocker();
		if (!dockerCheck.ok) {
			throw new Error(
				'Compose preflight failed: Docker is not available.\n' +
					'Docker must be running before install/update/apply operations.'
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
 * Bring an OP_HOME's RELEASE-SHIPPED assets to this build: overwrite the managed
 * `system/` tree and seed the user/data trees once.
 *
 * Split out of {@link applyHome} because this is exactly what a plain LAUNCH is
 * allowed to do, and the harnesses were doing less. Electron's
 * `seedBundledSkeleton` and the CLI supervisor both refresh the managed tree
 * before spawning the UI so an updated shell never serves the previous
 * release's managed files.
 *
 * #654: the akm-config heals that used to run HERE, on every apply, forever
 * (`stripRetiredAkmConfigKeys`, `reconcileDuplicateBundles`, `ensureSystemBundle`)
 * moved to home-schema.ts's versioned `MIGRATIONS` — each is a release-transition
 * heal (a shape an OLDER release wrote), not a steady-state invariant, so it
 * belongs behind a `since` gate with its own test rather than an unbounded
 * "what do I delete?" sweep. They still reach every launch path, including the
 * one this function does NOT cover (a plain desktop/CLI-supervisor launch runs
 * only `applyHomeAssets`, never `runHomeMigrations`): the UI child process
 * every such launch spawns runs `runHomeMigrations` itself, once, at startup
 * (`packages/ui/src/hooks.server.ts`'s `migrateHome`) — the same "one owner
 * covers the Electron harness, the CLI supervisor, and `vite dev` alike"
 * arrangement schema migrations already used for everything else.
 *
 * What deliberately stays behind in `applyHome`: secrets, addon state, image
 * versions and the `remote` serve config. Those reconcile RUNTIME state, and
 * `applyHome` runs them under the install lock behind a durable backup and a
 * rollback snapshot — a launch holds none of those.
 */
export async function applyHomeAssets(state: ControlPlaneState): Promise<void> {
	// #636: a plain launch reaches this directly (Electron's seedBundledSkeleton,
	// the CLI's spawnUiChild) with no snapshot/rollback safety net around it, so
	// the check belongs here too, not only at the install/update/upgrade entry
	// points below — this is the call that overwrites system/ and re-stamps
	// .skeleton-version.
	assertHomeNotNewerThanApp(state);
	await applyHomeSeed(state.homeDir);
	// akm's DATA, not its config: on macOS/Windows the containers' bind mounts
	// always cross a VM filesystem, where SQLite WAL cannot work, so akm >= 0.9.6
	// opens its stores in DELETE journal mode — but WAL residue left by an older
	// akm (un-checkpointed `-wal` sidecars under data/akm/data/, holding
	// potentially months of state) makes every in-container open fail "database
	// is locked" on every boot. Only the host can checkpoint that WAL back in,
	// and it must happen before the stack starts. No-op on Linux (native binds —
	// in-container WAL is legitimate there) and on healthy homes; never throws
	// (failures log and retry on the next pass). This one stays here rather than
	// moving to MIGRATIONS: it repairs whatever WAL residue is on disk RIGHT NOW,
	// not one historical shape, so it has to run on every apply to catch residue
	// left by whichever akm version most recently touched the store.
	reconcileAkmDbJournalMode(state);
}

/**
 * Bring an OP_HOME's assets to the running platform version — the "apply" half
 * of the single install==update path (constitution §1, §3, §4).
 *
 * Ownership is by top-level tree, so the write policy follows the destination.
 * Every step is idempotent:
 *   • ensureHomeDirs        — create the OP_HOME directory layout
 *   • ensureSecrets         — generate any missing service secrets
 *   • applyHomeAssets       — overwrite the managed system/ tree wholesale +
 *                             seed the user/data trees once (skip-existing) +
 *                             heal the akm configs and SQLite journal modes
 *                             that tree depends on
 *   • reconcileRemoteAccess — regenerate the `remote` addon's serve config
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
	await runHomeMigrations(state.homeDir);
	ensureSecrets(state);
	await applyHomeAssets(state);
	// Make the `remote` addon's generated serve config match its persisted state
	// on every install/update, and pin OP_REMOTE_HOSTNAME while doing it. This
	// has to happen HERE, in the one function that owns OP_HOME's assets, and
	// specifically BEFORE any compose command runs: `tunnel` bakes both inputs
	// in at container-create time. compose reads OP_REMOTE_HOSTNAME to set the
	// container's `hostname:` (its tailnet node name), and containerboot
	// log.Fatalf's at startup if it cannot register an fsnotify watch on the
	// directory holding TS_SERVE_CONFIG — so a first start with neither pinned
	// nor generated would register the node under the wrong name AND crash-loop
	// the sidecar.
	//
	// Never throws (access-apply.ts convention); a failure is reported in the
	// result rather than aborting an install over an addon that may be off.
	// Deliberately unconditional, NOT gated on the addon being enabled: the
	// disabled path writes the explicit empty "serve nothing, funnel nothing"
	// document, which is how turning `remote` off actually closes the door — an
	// absent file reads to Tailscale as "no change" and would leave a
	// previously-funneled service public indefinitely.
	const remote = reconcileRemoteAccess(state.homeDir);
	if (remote.error) {
		lifecycleLogger.warn('failed to reconcile remote access serve config', {
			error: remote.error
		});
	}
	pruneRemovedAddonState(state.homeDir);
	ensureVersionDefaults(state);
	ensureOpenCodeConfig();
	ensureOpenCodeSystemConfig();
}

type LockedLifecycleOptions = { lock?: InstallLockHandle | null };

function resolveLifecycleLock(
	state: ControlPlaneState,
	opts?: LockedLifecycleOptions
): InstallLockHandle | null {
	if (opts && 'lock' in opts) return opts.lock ?? null;
	return acquireInstallLock(state.dataDir);
}

function releaseLifecycleLock(lock: InstallLockHandle | null, opts?: LockedLifecycleOptions): void {
	if (opts && 'lock' in opts) return;
	releaseInstallLock(lock);
}

async function applyManagedFiles(
	state: ControlPlaneState,
	activateServices = false
): Promise<string> {
	const overlayCheck = checkCustomComposeChannelLan(state.homeDir);
	if (overlayCheck.blockError) throw new Error(overlayCheck.blockError);
	if (overlayCheck.warning) lifecycleLogger.warn(overlayCheck.warning);

	// The durable operator backup precedes every migration or managed-file write.
	// Rollback snapshots remain narrow and are used only for automatic recovery.
	const backupDir = backupOpenPalmHome(state.homeDir);
	if (backupDir) pruneBackupDirs(state.homeDir, 3);

	// Snapshot BEFORE migrating: a rollback snapshot must pair the env with
	// the system/ tree it was written FOR. migrateChatAddonRemoval (v7 → v8)
	// is the first migration that is not value-preserving — it moves the
	// guardian's deploy reason onto state only the NEW compose files
	// understand — so a post-migration env captured beside the pre-update
	// system tree would resolve profiles the old compose never declared.
	// state/schema-version is part of the snapshot, so a restored home simply
	// re-runs its migrations on the next attempt. (A pre-consolidation home's
	// snapshot may capture no stack env at all; every migration below the
	// consolidation is value-preserving, so there is nothing to roll back.)
	const generation = snapshotCurrentState(state);
	await runHomeMigrations(state.homeDir);
	const previousPlatformVersion = readSkeletonVersion(state.homeDir);
	advanceManagedImageVersions(state, previousPlatformVersion);
	// #660: a compose-published host port left ABSENT falls straight through
	// to compose's own bare `${KEY:-default}` — the port migrations above only
	// ever considered assistant/ui, so every other default (workspace, api,
	// guardian, guardian-admin, paperclip, voice) was host-blind: two sibling
	// installs could both land on the same default and collide. Runs on both
	// install and update, and BEFORE applyHome/reconcileCore so the resolved
	// value is what the stack actually activates with, not a value chosen
	// after compose already tried (and failed) to bind the busy default.
	await ensureHostPortDefaults(state);
	await applyHome(state);
	await reconcileCore(state, { activateServices });
	return generation;
}

async function reapplyRestoredStack(state: ControlPlaneState): Promise<void> {
	// Recovery path: the restored pre-upgrade config was live before the failed
	// apply, so it must not be vetoed by the activation audit — a veto here
	// would leave the stack down. Reapply through the bare compose driver
	// instead of activateStack (callers already hold the install lock).
	const result = await applyStack({ kind: 'all' }, buildComposeOptions(state), undefined, {
		pull: 'missing'
	});
	if (!result.ok) throw new Error(result.error ?? 'Failed to reapply restored stack');
}

export async function restoreSnapshotAndApplyStack(
	state: ControlPlaneState,
	opts: { generation?: string; lock?: InstallLockHandle } = {}
): Promise<void> {
	restoreSnapshot(state, opts.generation);
	await reapplyRestoredStack(state);
}

async function runWithSnapshotRollback(
	state: ControlPlaneState,
	run: () => Promise<void>,
	shouldReapplyStack: boolean | (() => boolean) = false,
	generation?: string | (() => string | undefined),
	preserveImages?: () => Promise<void>
): Promise<void> {
	try {
		await run();
	} catch (error) {
		let restored = false;
		const recoveryFailures: string[] = [];
		try {
			const selectedGeneration = typeof generation === 'function' ? generation() : generation;
			restoreSnapshot(state, selectedGeneration);
			restored = true;
		} catch (restoreError) {
			const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
			lifecycleLogger.error('failed to restore lifecycle snapshot', { error: message });
			recoveryFailures.push(`snapshot restore failed: ${message}`);
		}
		try {
			await preserveImages?.();
		} catch (imageError) {
			lifecycleLogger.error('failed to preserve pre-upgrade images', { error: String(imageError) });
		}
		const reapplyStack =
			typeof shouldReapplyStack === 'function' ? shouldReapplyStack() : shouldReapplyStack;
		if (restored && reapplyStack) {
			try {
				await reapplyRestoredStack(state);
			} catch (reapplyError) {
				const message = reapplyError instanceof Error ? reapplyError.message : String(reapplyError);
				lifecycleLogger.error('failed to reapply restored stack', { error: message });
				recoveryFailures.push(`restored stack reapply failed: ${message}`);
			}
		}
		// A recovery failure must reach the caller, not just the log: append it
		// to the original error so the surfaced message says both what broke the
		// apply AND that the automatic rollback did not fully recover.
		if (recoveryFailures.length > 0 && error instanceof Error) {
			error.message = `${error.message} Additionally, automatic rollback did not fully recover: ${recoveryFailures.join('; ')}`;
		}
		throw error;
	}
}

export async function applyInstall(
	state: ControlPlaneState,
	opts?: LockedLifecycleOptions
): Promise<void> {
	const lock = resolveLifecycleLock(state, opts);
	if (!lock) throw new Error('Another install is already in progress');
	try {
		// #636: checked before runWithSnapshotRollback, not inside it — a refusal
		// here must be a true no-op (no snapshot, no restore-from-an-unrelated
		// earlier generation), not just "no managed write".
		assertHomeNotNewerThanApp(state);
		let generation: string | undefined;
		await runWithSnapshotRollback(
			state,
			async () => {
				// F1: run the rootless ownership reconcile BEFORE the first managed
				// write, mirroring performUpgrade below. Without this, a fresh rootless
				// install's first `up` could hit unwritable operator-owned bind dirs
				// before any chown ever ran — the chown pass was wired into
				// start/upgrade/up but not this, the actual install path.
				// Skippable (like OP_SKIP_COMPOSE_PREFLIGHT) for tests and environments
				// that manage ownership externally, since it shells out to docker.
				if (!process.env.OP_SKIP_OWNERSHIP_RECONCILE) {
					await reconcileHostOwnership(state, { services: await buildManagedServices(state), repair: 'always' });
				}
				generation = await applyManagedFiles(state, true);
				ensureComposeVolumeTargets(state);
			},
			false,
			() => generation
		);
	} finally {
		releaseLifecycleLock(lock, opts);
	}
}

export async function applyUpdate(
	state: ControlPlaneState,
	opts?: LockedLifecycleOptions
): Promise<void> {
	const lock = resolveLifecycleLock(state, opts);
	if (!lock) throw new Error('Another install is already in progress');
	try {
		// #636: see applyInstall above for why this runs before the rollback wrapper.
		assertHomeNotNewerThanApp(state);
		let generation: string | undefined;
		await runWithSnapshotRollback(
			state,
			async () => {
				generation = await applyManagedFiles(state);
			},
			false,
			() => generation
		);
	} finally {
		releaseLifecycleLock(lock, opts);
	}
}

export async function applyUninstall(
	state: ControlPlaneState,
	opts?: LockedLifecycleOptions
): Promise<{ stopped: string[] }> {
	const lock = resolveLifecycleLock(state, opts);
	if (!lock) throw new Error('Another install is already in progress');
	try {
		const active = await reconcileCore(state, { deactivateServices: true });
		return { stopped: active };
	} finally {
		releaseLifecycleLock(lock, opts);
	}
}

/** Refresh managed files, pull every active image, then apply the stack once. */
export async function performUpgrade(
	state: ControlPlaneState,
	opts?: LockedLifecycleOptions
): Promise<void> {
	const lock = resolveLifecycleLock(state, opts);
	if (!lock) throw new Error('Another install is already in progress');
	let containersMutated = false;
	let generation: string | undefined;
	let imageSnapshot: RunningImageSnapshot = {};
	try {
		// #636: see applyInstall above for why this runs before the rollback
		// wrapper — nothing, not even the running-image capture below, should
		// happen once this home is known to be newer than the running app.
		assertHomeNotNewerThanApp(state);
		imageSnapshot = await captureRunningImageIds(buildComposeOptions(state));
		await runWithSnapshotRollback(
			state,
			async () => {
				if (!process.env.OP_SKIP_OWNERSHIP_RECONCILE) {
					await reconcileHostOwnership(state, { services: await buildManagedServices(state), repair: 'always' });
				}
				generation = await applyManagedFiles(state, true);

				const renameTeardown = await teardownRenamedProject(state);
				if (renameTeardown.warning) lifecycleLogger.warn(renameTeardown.warning);
				if (renameTeardown.downed) containersMutated = true;
				if (renameTeardown.blocked) {
					throw new Error(renameTeardown.warning ?? 'Project rename teardown failed.');
				}

				// A dev tag is a local build that was never pushed anywhere, so an explicit
				// `compose pull` can only fail; fold any fetch into `up` the way runDeploy
				// (deploy.ts) already does. Every published tag pulls first.
				const isDevTag = (readStackEnv(state.homeDir).OP_ASSISTANT_VERSION ?? '').startsWith('dev');
				const result = await activateStack(state, { kind: 'all' }, { pull: isDevTag ? 'missing' : 'always' }, { lock });
				if (!result.ok) {
					containersMutated = containersMutated || result.pullFailed !== true;
					throw new Error(result.error ?? 'Failed to apply stack');
				}

				// #585 decision 585-B: reclaim the named volumes retired by #585
				// (assistant-artifacts, guardian-cache, portal-cache) — image-baked/cache
				// content only, nothing durable. Runs AFTER the new stack is confirmed
				// up, so a reclaim failure can never strand this upgrade; failures are
				// logged, never thrown.
				await reapAndLogRetiredVolumes(state.homeDir, lifecycleLogger);
			},
			() => containersMutated,
			() => generation,
			async () => {
				if (generation && Object.keys(imageSnapshot).length > 0) {
					await restoreRunningImageIds(state, imageSnapshot, generation);
				}
			}
		);
	} finally {
		releaseLifecycleLock(lock, opts);
	}
}

export function buildComposeFileList(state: ControlPlaneState): string[] {
	return discoverStackOverlays(state.homeDir);
}

// Guardian is shared ingress, not an addon service of its own
// (getAddonServiceNames deliberately excludes it). Whether it deploys is
// guardianRequired (guardian-required.ts): a guardian-ingress addon, a
// guardian access toggle, or a remote tunnel targeting it — mirroring the
// profile gate on the guardian service in portals.compose.yml.
//
// Deploy dependency contract (one place to read it):
//   • assistant — ALWAYS deployed; depends on nothing.
//   • guardian  — shared ingress; deployed ONLY when guardianRequired;
//                 depends on assistant.
//   • portals  — each depends on guardian (compose `depends_on`), so they are
//                 never deployed without it.
// An install with no guardian reason therefore deploys assistant alone and
// must NOT include or health-wait on guardian. The integration test in
// guardian-gating.test.ts pins this.

export async function buildManagedServices(state: ControlPlaneState): Promise<string[]> {
	const composeOpts = buildComposeOptions(state);

	// The assistant is the only ALWAYS-on core service. Guardian is profile-gated
	// in portals.compose.yml, so without a guardianRequired reason it is
	// never deployed. Seeding it unconditionally
	// made the installer health-wait on a guardian that never starts (a ~5-minute
	// hang when no ingress is selected). Add it back ONLY when required;
	// that also preserves the #450 need to force-recreate guardian on
	// upgrade when its profiles ARE active (it is excluded from
	// getAddonServiceNames, so the fallback below would otherwise drop it).
	const enabledAddons = listEnabledAddonIds(state.homeDir);
	const services = new Set<string>(['assistant']);
	if (guardianRequired(state.homeDir)) services.add('guardian');

	// Prefer compose-derived service list when Docker is available. Resolved with
	// the active profiles, this already includes guardian iff an ingress profile
	// is active — the explicit add above just guarantees it for the fallback.
	if (composeOpts.files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
		const result = await composeConfigServices(composeOpts);
		if (result.ok && result.services.length > 0) {
			for (const s of result.services) services.add(s);
			return [...services];
		}
	}

	// Fallback: static inference from assistant (+ guardian when ingress is enabled) +
	// active addon overlays.
	for (const addon of enabledAddons) {
		for (const s of getAddonServiceNames(state.homeDir, addon)) services.add(s);
	}
	return [...services];
}

const VALID_CALLERS = new Set<CallerType>(['assistant', 'cli', 'ui', 'system', 'test']);

export function normalizeCaller(headerValue: string | null): CallerType {
	const v = (headerValue ?? '').trim().toLowerCase() as CallerType;
	return VALID_CALLERS.has(v) ? v : 'unknown';
}
