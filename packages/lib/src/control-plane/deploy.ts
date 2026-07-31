import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { CORE_SERVICES } from './types.js';
import { hasGuardianIngressAddon } from './addon-ids.js';
import { listEnabledAddonIds } from './addons.js';
import { writeFileAtomic } from './fs-atomic.js';
import { buildComposeOptions } from './compose-args.js';
import { applyInstall, buildManagedServices } from './lifecycle.js';
import {
	composePs,
	detectExistingProject,
	isComposePsRowHealthy,
	parseComposePsRows,
	resolveComposeProjectName,
	type ApplyStackResult
} from './docker.js';
import { activateStack } from './activation.js';
import { reapAndLogRetiredVolumes } from './image-volume-retention.js';
import { parseEnvFile } from './env.js';
import { patchStateEnvFile, readStackEnv } from './secrets.js';
import {
	acquireInstallLock,
	releaseInstallLock,
	isProcessAlive,
	type InstallLockHandle
} from './install-lock.js';
import { resolveBackupsDir } from './home.js';
import { stackEnvPath } from './paths.js';
import { discoverStackOverlays } from './config-persistence.js';
import { teardownRenamedProject } from './project-rename.js';
import { auditComposeSecrets } from './secret-audit.js';
import { validateProposedState } from './validate.js';
import { createLogger } from '../logger.js';
import { restoreSnapshot } from './rollback.js';
import { currentSnapshotGeneration } from './rollback.js';
import { captureRunningImageIds, restoreRunningImageIds, type RunningImageSnapshot } from './image-snapshots.js';

const deployLogger = createLogger('deploy');

function restoreDeployFiles(state: ControlPlaneState, generation?: string): void {
	try {
		restoreSnapshot(state, generation);
	} catch (error) {
		deployLogger.error('failed to restore deploy snapshot', {
			error: error instanceof Error ? error.message : String(error)
		});
	}
}

async function restoreDeployStack(
	state: ControlPlaneState,
	lock?: InstallLockHandle,
	images: RunningImageSnapshot = {},
	generation?: string
): Promise<void> {
	try {
		restoreSnapshot(state, generation);
		if (generation && Object.keys(images).length > 0) {
			await restoreRunningImageIds(state, images, generation);
		}
		const result = await activateStack(state, { kind: 'all' }, { pull: 'missing' }, { lock });
		if (!result.ok) throw new Error(result.error ?? 'Failed to reapply restored stack');
	} catch (error) {
		deployLogger.error('failed to restore deployed stack', {
			error: error instanceof Error ? error.message : String(error)
		});
	}
}

export type DeployEntry = {
	service: string;
	status: 'pending' | 'running' | 'error' | 'warning';
	label: string;
};

export type DeployPhase =
	| 'writing-config'
	| 'pulling-images'
	| 'starting'
	| 'ready';

export type DeployJournal = {
	deploying: boolean;
	interrupted?: boolean;
	setupComplete: boolean;
	deployStatus: DeployEntry[];
	deployError: string | null;
	imageWarning: string | null;
	phase: DeployPhase;
	startedAt: string | null;
	pid: number | null;
};

export type DeployProgress = DeployJournal;

type RunDeployOptions = {
	journalPath?: string;
	onUpdate?: (state: DeployProgress) => void;
	markSetupComplete?: () => void;
};

const DEFAULT_DEPLOY_PROGRESS: DeployProgress = {
	deploying: false,
	setupComplete: false,
	deployStatus: [],
	deployError: null,
	imageWarning: null,
	phase: 'writing-config',
	startedAt: null,
	pid: null
};

function cloneProgress(state: DeployProgress): DeployProgress {
	return { ...state, deployStatus: state.deployStatus.map((entry) => ({ ...entry })) };
}

function updateProgress(current: DeployProgress, patch: Partial<DeployProgress>): DeployProgress {
	return cloneProgress({ ...current, ...patch });
}

export function writeJournal(path: string, state: DeployProgress): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function readDeployJournal(path: string): DeployProgress {
	if (!existsSync(path)) return cloneProgress(DEFAULT_DEPLOY_PROGRESS);
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DeployProgress>;
		const state = updateProgress(DEFAULT_DEPLOY_PROGRESS, {
			deploying: parsed.deploying === true,
			interrupted: parsed.interrupted === true,
			setupComplete: parsed.setupComplete === true,
			deployStatus: Array.isArray(parsed.deployStatus)
				? parsed.deployStatus.filter((entry): entry is DeployEntry =>
						Boolean(
							entry &&
								typeof entry.service === 'string' &&
								typeof entry.label === 'string' &&
								typeof entry.status === 'string'
						)
					)
				: [],
			deployError: typeof parsed.deployError === 'string' ? parsed.deployError : null,
			imageWarning: typeof parsed.imageWarning === 'string' ? parsed.imageWarning : null,
			phase: parsed.phase ?? 'writing-config',
			startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
			pid: typeof parsed.pid === 'number' ? parsed.pid : null
		});
		if (state.deploying && state.pid && !isProcessAlive(state.pid)) {
			state.deploying = false;
			state.interrupted = true;
			state.deployError =
				state.deployError ?? 'Deployment was interrupted. Retry to resume Docker deploy.';
		}
		return state;
	} catch {
		return cloneProgress(DEFAULT_DEPLOY_PROGRESS);
	}
}

export function resolveDeployJournalPath(state: ControlPlaneState): string {
	return join(state.dataDir, 'setup', 'deploy-journal.json');
}

function emitProgress(options: RunDeployOptions, state: DeployProgress): void {
	if (options.journalPath) writeJournal(options.journalPath, state);
	options.onUpdate?.(cloneProgress(state));
}

function projectNameForState(state: ControlPlaneState): string {
	return resolveComposeProjectName(parseEnvFile(stackEnvPath(state)));
}

function resolveImageTag(state: ControlPlaneState): string {
	const env = readStackEnv(state.homeDir);
	return env.OP_ASSISTANT_VERSION ?? env.OP_IMAGE_TAG ?? '';
}

async function detectProjectCollision(state: ControlPlaneState): Promise<string | null> {
	const projectName = projectNameForState(state);
	const delays = [0, 1_000, 1_000];
	for (let attempt = 0; attempt < delays.length; attempt++) {
		if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
		const existing = await detectExistingProject({
			projectName,
			expectedWorkingDir: state.stackDir
		});
		if (existing.error) continue;
		if (!existing.exists) return null;
		if (existing.isOurs) return null;
		if (!existing.workingDir) continue;
		return `Refusing to deploy: docker project "${projectName}" is already running from ${existing.workingDir}, but this deploy would use OP_HOME=${state.homeDir}. Set OP_PROJECT_NAME to a distinct value in stack.env, or stop the existing stack first.`;
	}
	return `Refusing to deploy: docker project "${projectName}" could not be verified safely. Docker returned an existing project without a trustworthy working_dir label, so this deploy is failing closed.`;
}

function buildLogHint(state: ControlPlaneState, services: string[]): string {
	return `Check logs: docker compose -p ${projectNameForState(state)} logs ${services.join(' ')}.`;
}

/**
 * §2.1: `compose up -d --wait` IS the health gate now — this no longer polls
 * or decides pass/fail. Demoted + renamed from the old pollContainerHealth
 * gate: ONE `compose ps` call refreshes the per-service display labels the UI
 * shows. On a successful `up`, `--wait` already confirmed every requested
 * service is healthy, so every entry is marked running regardless of what
 * this best-effort ps call sees. On a failed `up`, the same single call NAMES
 * which services didn't come up (§2.1's "one compose ps --format json call
 * names the failed services"), split into required vs optional services.
 */
async function refreshDeployStatus(
	state: ControlPlaneState,
	progress: DeployProgress,
	upFailed: boolean,
	requiredServices: ReadonlySet<string>
): Promise<{ failedRequired: string[]; failedOptional: string[] }> {
	const composeOpts = buildComposeOptions(state);
	const psResult = await composePs(composeOpts);
	const rows = psResult.ok ? parseComposePsRows(psResult.stdout) : [];

	const failedRequired: string[] = [];
	const failedOptional: string[] = [];

	progress.deployStatus = progress.deployStatus.map((entry) => {
		const row = rows.find((r) => r.service === entry.service);
		const healthy = isComposePsRowHealthy(row);
		if (healthy || !upFailed) {
			return { ...entry, status: 'running', label: 'Running' };
		}
		(requiredServices.has(entry.service) ? failedRequired : failedOptional).push(entry.service);
		const label = !row
			? 'Did not start'
			: row.health.toLowerCase() === 'unhealthy'
				? 'Unhealthy'
				: row.health.toLowerCase() === 'starting'
					? 'Starting'
					: `Exited (${row.state || 'unknown'})`;
		return { ...entry, status: 'error', label };
	});

	return { failedRequired, failedOptional };
}

/**
 * How often the interim poll below peeks at `compose ps` while `activateStack`
 * is in flight. Read-only and best-effort — it never decides pass/fail (that
 * stays refreshDeployStatus's job once activateStack resolves) and never
 * issues another compose mutation, so it cannot race or compete with compose's
 * own `--wait` health gate.
 */
const INTERIM_STATUS_POLL_MS = 5_000;

/**
 * W7: `activateStack` (pull + up, §4.3) is ONE call with no progress
 * callback, so the journal would otherwise sit frozen on "Waiting..." for the
 * entire pull and the entire up/health-wait. Poll `compose ps` on the side
 * while that call is outstanding so the wizard's rows move as containers
 * actually appear. The first non-empty `compose ps` result is also the
 * signal that the discrete pull finished and `up` began creating containers,
 * so it flips the phase from 'pulling-images' to 'starting'.
 *
 * Deliberately conservative: a row is only ever promoted to 'running' here
 * (once compose reports it healthy); nothing is ever marked 'error' —
 * a container still warming up mid-pull is not a failure, and the actual
 * failure determination belongs solely to refreshDeployStatus() after
 * activateStack returns.
 */
function startInterimStatusPoll(
	state: ControlPlaneState,
	options: RunDeployOptions,
	progress: DeployProgress
): { stop: () => void } {
	const composeOpts = buildComposeOptions(state);
	let stopped = false;
	let tickInFlight = false;
	const tick = async () => {
		if (stopped || tickInFlight) return;
		tickInFlight = true;
		try {
			const psResult = await composePs(composeOpts);
			if (stopped || !psResult.ok) return;
			const rows = parseComposePsRows(psResult.stdout);
			if (rows.length === 0) return;
			if (progress.phase === 'pulling-images') progress.phase = 'starting';
			progress.deployStatus = progress.deployStatus.map((entry) => {
				const row = rows.find((r) => r.service === entry.service);
				if (!row) return entry;
				return isComposePsRowHealthy(row)
					? { ...entry, status: 'running', label: 'Running' }
					: { ...entry, status: 'pending', label: 'Starting...' };
			});
			emitProgress(options, progress);
		} finally {
			tickInFlight = false;
		}
	};
	const timer = setInterval(() => { void tick(); }, INTERIM_STATUS_POLL_MS);
	return {
		stop: () => {
			stopped = true;
			clearInterval(timer);
		}
	};
}

export function markSetupComplete(state: ControlPlaneState): void {
	// OP_SETUP_COMPLETE is an app-written record → the single state/stack.env
	// (constitution §1).
	patchStateEnvFile(state.homeDir, { OP_SETUP_COMPLETE: 'true' });
}

export function backupSetupInputs(state: ControlPlaneState): string | null {
	const stackEnvFile = stackEnvPath(state);
	const secretsDir = `${state.stashDir}/secrets`;
	if (!existsSync(stackEnvFile) && !existsSync(secretsDir)) return null;
	const backupDir = join(
		resolveBackupsDir(),
		`${new Date().toISOString().replace(/[:.]/g, '-')}-setup`
	);
	if (existsSync(stackEnvFile)) {
		const dest = join(backupDir, 'state/stack.env');
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(stackEnvFile, dest);
	}
	if (existsSync(secretsDir)) {
		const copyDir = (sourceDir: string, targetDir: string) => {
			mkdirSync(targetDir, { recursive: true });
			for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
				const sourcePath = join(sourceDir, entry.name);
				const targetPath = join(targetDir, entry.name);
				if (entry.isDirectory()) {
					copyDir(sourcePath, targetPath);
					continue;
				}
				copyFileSync(sourcePath, targetPath);
			}
		};
		copyDir(secretsDir, join(backupDir, 'knowledge/secrets'));
	}
	return backupDir;
}

/**
 * Secret-boundary + runtime-config gate the deploy runs before it touches any
 * container (S.2.2). Before this, neither `auditComposeSecrets` nor
 * `validateProposedState` was invoked outside the manual `openpalm audit-secrets`
 * command, so an apply could grant a secret across the boundary unchecked. Runs
 * `auditComposeSecrets` over the on-disk compose overlays plus
 * `validateProposedState`; `error`-severity audit issues and validation errors
 * block the deploy, warnings are returned for the caller to log and continue.
 */
export async function auditApplyState(
	state: ControlPlaneState
): Promise<{ errors: string[]; warnings: string[] }> {
	const errors: string[] = [];
	const warnings: string[] = [];

	for (const file of discoverStackOverlays(state.homeDir)) {
		for (const auditIssue of auditComposeSecrets(readFileSync(file, 'utf-8'))) {
			const where = auditIssue.path ? `${file}:${auditIssue.path}` : file;
			const line = `${auditIssue.code}: ${auditIssue.message} (${where})`;
			(auditIssue.severity === 'error' ? errors : warnings).push(line);
		}
	}

	const validation = await validateProposedState(state);
	errors.push(...validation.errors);
	warnings.push(...validation.warnings);

	return { errors, warnings };
}

export async function runDeploy(
	state: ControlPlaneState,
	options: RunDeployOptions = {}
): Promise<DeployProgress> {
	const progress = cloneProgress(DEFAULT_DEPLOY_PROGRESS);
	progress.deploying = true;
	progress.startedAt = new Date().toISOString();
	progress.pid = process.pid;
	emitProgress(options, progress);

	const lock = acquireInstallLock(state.dataDir);
	if (!lock) {
		progress.deploying = false;
		progress.deployError =
			"install_in_progress: A deploy is already running. Wait for it to finish (the lock clears itself automatically after 30 minutes). If you're sure nothing is running, run 'openpalm unlock' to clear a stale lock.";
		emitProgress(options, progress);
		return progress;
	}
	let imageSnapshot: RunningImageSnapshot = {};
	let generation: string | undefined;

	try {
		imageSnapshot = await captureRunningImageIds(buildComposeOptions(state));
		const collision = await detectProjectCollision(state);
		if (collision) {
			progress.deployError = collision;
			progress.deploying = false;
			emitProgress(options, progress);
			return progress;
		}

		progress.phase = 'writing-config';
		emitProgress(options, progress);
		await applyInstall(state, { lock });
		generation = currentSnapshotGeneration() ?? undefined;

		// Validate the written config BEFORE touching containers (S.2.2). Route a
		// blocking failure through deployError — the same user-visible surface as a
		// compose failure — so an unauthorized secret grant refuses the deploy.
		const audit = await auditApplyState(state);
		for (const warning of audit.warnings) deployLogger.warn(warning);
		if (audit.errors.length > 0) {
			restoreDeployFiles(state);
			progress.deployError = `Refusing to deploy: configuration validation failed.\n${audit.errors.join('\n')}`;
			progress.deploying = false;
			emitProgress(options, progress);
			return progress;
		}

		const services = await buildManagedServices(state);
		const requiredServices = new Set<string>(CORE_SERVICES);
		if (hasGuardianIngressAddon(listEnabledAddonIds(state.homeDir))) {
			requiredServices.add('guardian');
		}
		progress.deployStatus = services.map((service) => ({
			service,
			status: 'pending',
			label: 'Waiting...'
		}));
		emitProgress(options, progress);

		// Project rename (#540): if OP_PROJECT_NAME changed since the last apply,
		// the composeDown below only targets the NEW name — the still-running old
		// project would keep its containers (and host ports) forever. Tear the
		// recorded outgoing project down first, before anything comes up. A
		// blocked teardown (down failed, old project still holding ports) must
		// abort the deploy — continuing would bring up a colliding second stack.
		const renameTeardown = await teardownRenamedProject(state);
		if (renameTeardown.warning) deployLogger.warn(renameTeardown.warning);
		if (renameTeardown.blocked) {
			restoreDeployFiles(state);
			progress.deployError = renameTeardown.warning ?? 'Project rename teardown failed.';
			progress.deploying = false;
			emitProgress(options, progress);
			return progress;
		}
		if (renameTeardown.downed) {
			deployLogger.info(
				`project rename: stopped previous docker project "${renameTeardown.downed}"`
			);
		}

		const imageTag = resolveImageTag(state);
		const isDevTag = imageTag.startsWith('dev');

		// W7: a dev tag uses `pull: 'missing'` — any fetch is folded into `up`
		// itself, so there's no separate download wait to announce. Every other
		// tag pulls first (`pull: 'always'`), which is the multi-GB, multi-minute
		// wait the wizard has dedicated copy for ("Downloading Images…") — give it
		// its own phase instead of leaving 'starting' (and its "0 of N services
		// running" subtitle) covering both the download and the actual startup.
		progress.phase = isDevTag ? 'starting' : 'pulling-images';
		progress.deployStatus = progress.deployStatus.map((entry) => ({
			...entry,
			status: 'pending',
			label: isDevTag ? 'Starting...' : 'Waiting to download...'
		}));
		emitProgress(options, progress);

		let stackResult: ApplyStackResult;
		const interimPoll = startInterimStatusPoll(state, options, progress);
		try {
			stackResult = await activateStack(
				state,
				{ kind: 'all' },
				{
					pull: isDevTag ? 'missing' : 'always',
					healthTimeoutMs: 5 * 60_000
				},
				{ lock }
			);
		} catch (error) {
			restoreDeployFiles(state, generation);
			progress.deployError = error instanceof Error ? error.message : String(error);
			progress.deploying = false;
			emitProgress(options, progress);
			return progress;
		} finally {
			interimPoll.stop();
		}

		// The interim poll above flips 'pulling-images' → 'starting' the moment it
		// OBSERVES containers being (re)created — a best-effort signal that can
		// miss a fast up (finishes between poll ticks). Force the transition here
		// too so the phase sequence is guaranteed writing-config → pulling-images →
		// starting → ready regardless of timing; a failure right after overrides
		// the visible title via `deployError`, so this is never shown as a false
		// "now starting" on a pull that actually failed.
		progress.phase = 'starting';
		emitProgress(options, progress);

		if (!stackResult.ok) {
			// ONE `compose ps` refreshes the per-service display labels and splits the
			// failures into required vs optional. Guardian is required whenever an
			// ingress addon enables it; adapter failures remain warnings. `upFailed`
			// means nothing came up at all and is always a hard failure.
			const { failedRequired, failedOptional } = await refreshDeployStatus(
				state,
				progress,
				true,
				requiredServices
			);
			if (stackResult.pullFailed || failedRequired.length > 0 || stackResult.upFailed) {
				if (stackResult.pullFailed && !renameTeardown.downed) restoreDeployFiles(state);
				else await restoreDeployStack(state, lock, imageSnapshot, generation);
				const allFailed = [...failedRequired, ...failedOptional];
				const failureDetail =
					allFailed.length > 0 ? allFailed.join(', ') : (stackResult.error ?? 'stack update');
				progress.deployError = isDevTag
					? `Dev images not found locally or failed to start (tag: ${imageTag}): ${failureDetail}. Run \`bun run dev:build\` from the project root to build them, then retry setup.`
					: `Stack update failed: ${failureDetail}.${allFailed.length > 0 ? ` ${buildLogHint(state, allFailed)}` : ''}`;
				progress.deploying = false;
				emitProgress(options, progress);
				return progress;
			}
			// Only optional adapter/services failed, so setup completes with a
			// warning rather than wedging a fresh install.
			// This early return would otherwise skip the success-path retired-volume
			// reap below, so reclaim before returning the warning.
			await reapAndLogRetiredVolumes(state.homeDir, deployLogger);
			// W5: the client's poll loop (setup-state.svelte.ts pollDeployStatus)
			// treats 'warning' rows as a non-blocking terminal state — every
			// required service is up, so a failed OPTIONAL row must read as "done,
			// with a warning" rather than 'error' (which reads as still-failing and
			// would poll forever, since nothing else ever produces a terminal state
			// here).
			progress.deployStatus = progress.deployStatus.map((entry) =>
				failedOptional.includes(entry.service) ? { ...entry, status: 'warning' } : entry
			);
			progress.imageWarning = `The following optional service(s) did not start correctly and were skipped: ${failedOptional.join(', ')}. ${buildLogHint(state, failedOptional)}`;
			options.markSetupComplete?.();
			progress.deploying = false;
			progress.setupComplete = true;
			progress.phase = 'ready';
			emitProgress(options, progress);
			return progress;
		}

		// #585 decision 585-B: reclaim the named volumes retired by #585
		// (assistant-artifacts, guardian-cache, portal-cache) — image-baked/cache
		// content only, nothing durable. Runs AFTER the new stack is confirmed
		// up, so a reclaim failure can never strand this deploy; failures are
		// logged, never thrown. `openpalm install` on an EXISTING home drives the
		// same compose transition performUpgrade does (applyInstall overwrites
		// the managed compose files, applyStack brings the new stack up), so the
		// reap must run here too — otherwise a user who re-runs install instead
		// of update strands the retired volumes with no reclamation path
		// (uninstall --volumes can't see them once their declarations are gone,
		// and doctor --clean-docker's orphan detector only flags a DIFFERENT
		// project's volumes).
		await reapAndLogRetiredVolumes(state.homeDir, deployLogger);

		await refreshDeployStatus(state, progress, false, requiredServices);
		options.markSetupComplete?.();
		progress.deploying = false;
		progress.setupComplete = true;
		progress.phase = 'ready';
		emitProgress(options, progress);
		return progress;
	} catch (error) {
		// A thrown setup/deploy exception must not leave the journal claiming that
		// deployment is still active forever. Persist a terminal failure before
		// rethrowing so the UI and a later process can recover deterministically.
		progress.deploying = false;
		progress.deployError = error instanceof Error ? error.message : String(error);
		emitProgress(options, progress);
		throw error;
	} finally {
		releaseInstallLock(lock);
	}
}
