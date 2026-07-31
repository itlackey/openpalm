/**
 * Compose project rename handling (#540).
 *
 * The compose project name is never stored anywhere — every compose call
 * re-resolves it from stack.env at invocation time. So the moment
 * OP_PROJECT_NAME changes, the still-running containers of the OLD project
 * become unaddressable: every subsequent compose command targets the new
 * name, nothing enumerates the old one, and the stack splits across two
 * projects (only whatever the next apply touches moves to the new name,
 * while the rest keeps running — and holding host ports — under the old).
 *
 * The fix is two-phase:
 *   1. When the rename is SAVED (admin assistant settings), record the
 *      outgoing name as OP_PREVIOUS_PROJECT_NAME in the app-written
 *      state/stack.env via {@link recordProjectRename}. No compose
 *      runs at save time — the save path holds no install lock.
 *   2. When the stack is next APPLIED under the install lock (deploy,
 *      upgrade, CLI start/restart), {@link teardownRenamedProject} downs the
 *      recorded old project — after verifying via the compose working_dir
 *      label that it belongs to THIS install — then clears the marker.
 */
import { patchStateEnvFile, readStackEnv } from './secrets.js';
import type { ControlPlaneState } from './types.js';

// docker.js / compose-args.js are loaded LAZILY (inside teardownRenamedProject)
// rather than statically: several test harnesses mock.module() those files with
// partial export sets, and a static named import of a symbol absent from a mock
// is a load-time SyntaxError that breaks every consumer of this module — even
// callers that never reach the teardown path.
type DockerModule = typeof import('./docker.js');

export const PREVIOUS_PROJECT_NAME_KEY = 'OP_PREVIOUS_PROJECT_NAME';

/** Injectable docker surface so the teardown decision tree is unit-testable. */
export type ProjectRenameDeps = {
	detectExistingProject: DockerModule['detectExistingProject'];
	composeDownProject: DockerModule['composeDownProject'];
};

/**
 * Record that the compose project name is changing from `previousName` to
 * `nextName`, so the next locked apply can tear the old project down.
 *
 * Chain-safe: if a marker is already recorded, the RUNNING stack still wears
 * that original name (no apply has happened yet), so a second rename keeps
 * the original marker rather than overwriting it with an intermediate name
 * that never had containers. Renaming back to the recorded name simply
 * clears the marker — the running stack already matches.
 */
export function recordProjectRename(homeDir: string, previousName: string, nextName: string): void {
	if (previousName === nextName) return;
	const recorded = readStackEnv(homeDir)[PREVIOUS_PROJECT_NAME_KEY]?.trim() ?? '';
	if (recorded === nextName) {
		clearRecordedProjectRename(homeDir);
		return;
	}
	if (recorded) return;
	patchStateEnvFile(homeDir, { [PREVIOUS_PROJECT_NAME_KEY]: previousName });
}

/** Clear the rename marker (teardown done, or rename reverted). */
export function clearRecordedProjectRename(homeDir: string): void {
	patchStateEnvFile(homeDir, { [PREVIOUS_PROJECT_NAME_KEY]: '' });
}

export type ProjectRenameTeardown = {
	/** The old project that was actually downed, or null when nothing ran. */
	downed: string | null;
	/** Problem the caller should surface; null on clean runs. */
	warning: string | null;
	/**
	 * True when the outgoing project is still RUNNING but could not be
	 * stopped (the `down` failed). The marker is kept for retry, and bringing
	 * the stack up under the NEW name would collide with the old project's
	 * containers and host ports — callers must ABORT the apply and surface
	 * `warning` instead of continuing. NOT set when the old project was
	 * already fully stopped and `down` merely failed to clean it up (nothing
	 * is holding a port to collide with), nor for the foreign-project case
	 * (that project was never ours to stop).
	 */
	blocked: boolean;
};

/**
 * If a project rename is recorded, tear down the OUTGOING compose project so
 * the stack can come up whole under the new name (no orphaned containers, no
 * host-port conflicts). Call this from apply paths that hold the install
 * lock, BEFORE bringing the stack up.
 *
 * Safety rules:
 * - Only a project whose `com.docker.compose.project.working_dir` label
 *   matches THIS install is downed. A foreign project with the same name is
 *   skipped (marker cleared — retrying would never become safe).
 * - A failed `down` KEEPS the marker so the next apply retries, and returns
 *   `blocked: true` — the old project is still holding host ports, so the
 *   caller must abort rather than bring up a colliding second stack.
 * - No recorded rename, or a marker equal to the current name (rename
 *   reverted), is a cheap no-op.
 */
export async function teardownRenamedProject(
	state: ControlPlaneState,
	deps?: ProjectRenameDeps
): Promise<ProjectRenameTeardown> {
	const env = readStackEnv(state.homeDir);
	const previous = env[PREVIOUS_PROJECT_NAME_KEY]?.trim() ?? '';
	if (!previous) return { downed: null, warning: null, blocked: false };

	const docker = await import('./docker.js');
	const { buildComposeOptions } = await import('./compose-args.js');
	const resolvedDeps: ProjectRenameDeps = deps ?? {
		detectExistingProject: docker.detectExistingProject,
		composeDownProject: docker.composeDownProject
	};

	const current = docker.resolveComposeProjectName(env);
	if (previous === current) {
		clearRecordedProjectRename(state.homeDir);
		return { downed: null, warning: null, blocked: false };
	}

	const existing = await resolvedDeps.detectExistingProject({
		projectName: previous,
		expectedWorkingDir: state.stackDir
	});
	if (existing.error) {
		return {
			downed: null,
			warning: `Project rename: could not verify previous docker project "${previous}" (${existing.error}).`,
			blocked: true
		};
	}
	if (!existing.exists) {
		// Nothing AT ALL remains under the old name — `docker ps -a` found no
		// containers, running or stopped. Clear the marker: there is nothing
		// left to collide with, so there is nothing left to tear down either.
		//
		// A merely-STOPPED previous project does NOT reach this branch:
		// detectExistingProject probes `docker ps -a`, so it reports
		// `exists: true` for a stopped project too. That falls through to the
		// isOurs / composeDownProject path below exactly like a running
		// project would — which is what actually removes the leftover
		// containers instead of silently leaving them behind.
		clearRecordedProjectRename(state.homeDir);
		return { downed: null, warning: null, blocked: false };
	}
	if (!existing.isOurs) {
		clearRecordedProjectRename(state.homeDir);
		return {
			downed: null,
			warning:
				`Project rename: previous docker project "${previous}" is owned by another install ` +
				`(${existing.workingDir}); skipping teardown.`,
			blocked: false
		};
	}

	const result = await resolvedDeps.composeDownProject(previous, {
		...buildComposeOptions(state),
		removeOrphans: true
	});
	if (!result.ok) {
		// Only a RUNNING previous project is actually blocking: it still holds
		// host ports/the project name and would collide with the new one
		// coming up. A previous project that was already fully stopped holds
		// nothing — a failed `down` there just means leftover containers
		// weren't cleaned up, which must not abort the apply forever.
		// `running` is `undefined` for a caller-built fixture that predates
		// this field (or a detection/down timing gap) — treated as the risky
		// case rather than assumed safe.
		if (existing.running !== false) {
			return {
				downed: null,
				warning:
					`Project rename: failed to stop previous docker project "${previous}" ` +
					`(${result.stderr.trim() || `exit ${result.code}`}); it is still running and would ` +
					`collide with the new project name. Aborting; the rename will be retried on the next apply.`,
				blocked: true
			};
		}
		clearRecordedProjectRename(state.homeDir);
		return {
			downed: null,
			warning:
				`Project rename: previous docker project "${previous}" was already stopped but could not be ` +
				`fully removed (${result.stderr.trim() || `exit ${result.code}`}); leftover containers may ` +
				`remain (remove them manually if desired). Not aborting — nothing under the old name is running.`,
			blocked: false
		};
	}

	clearRecordedProjectRename(state.homeDir);
	return { downed: previous, warning: null, blocked: false };
}
