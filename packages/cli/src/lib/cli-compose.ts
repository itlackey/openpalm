/**
 * CLI Docker Compose orchestration.
 *
 * Delegates to @openpalm/lib for compose file resolution, CLI argument
 * construction, preflight checks, the preflight error message, AND the
 * stdio-inheriting compose invocation — the CLI keeps no compose logic of its
 * own beyond wiring the pieces together.
 */
import {
	buildComposeCliArgs,
	activateComposeCommand,
	checkLifecycleDiskHeadroom,
	composeUpTimeoutMs,
	describeLifecycleDiskHeadroom,
	ensureDockerReady,
	runComposeStreaming,
	runHomeMigrations,
	shouldBlockOnDiskHeadroom
} from '@openpalm/lib';
import type { ControlPlaneState, InstallLockHandle } from '@openpalm/lib';

/**
 * Run a compose command that does NOT mutate state (e.g. logs, ps, status).
 * Skips preflight validation since these commands are read-only. No timeout:
 * interactive follows (`logs -f`) legitimately run unbounded.
 */
export async function runComposeReadOnly(
	state: ControlPlaneState,
	composeSubArgs: string[]
): Promise<void> {
	const composeArgs = buildComposeCliArgs(state);
	await runComposeStreaming([...composeArgs, ...composeSubArgs]);
}

/**
 * Run compose preflight validation, then execute the compose command.
 * This is the canonical CLI mutation path — all compose operations
 * that modify state must go through this function.
 *
 * Preflight can be bypassed by setting OP_SKIP_COMPOSE_PREFLIGHT=1 (e.g. in tests).
 * The invocation carries lib's `up` timeout budget so a first install extracting
 * multi-GB images is bounded exactly like the capturing `composeUp` path.
 */
export async function runComposeWithPreflight(
	state: ControlPlaneState,
	composeSubArgs: string[],
	lock?: InstallLockHandle
): Promise<void> {
	runHomeMigrations(state.homeDir);

	// D1: a single "is Docker actually usable right now" readiness check ahead
	// of every day-2 lifecycle mutation (start/stop/restart/rollback/addon
	// enable/…). Catches the missing-binary and stopped-daemon cases with a
	// friendly, non-blank message BEFORE they can surface as the raw (sometimes
	// literally blank) `docker compose config --quiet` preflight error below —
	// `docker compose config` never contacts the daemon, so a stopped daemon
	// would otherwise sail through it. Gated on the same OP_SKIP_COMPOSE_PREFLIGHT
	// env used below so tests that fully mock this function stay green.
	if (!process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
		const ready = await ensureDockerReady();
		if (!ready.ok) throw new Error(ready.message);

		// S6: the disk-headroom half of the SAME lifecycle preamble (one
		// preflight, two checks — not a second bolted-on gate) — fails a
		// restart/install/update/backup closed BEFORE it can regenerate GBs of
		// cache into an already-full filesystem (#581 finding #10). Non-fatal by
		// default: only warns unless OP_DISK_HARD_BLOCK=1 is set AND the reading
		// is "critical" (S6: "make the hard-block threshold configurable/
		// off-by-default", to avoid refusing legitimate installs).
		// #588: this measures Docker's data root alongside OP_HOME whenever the
		// two are separate filesystems — image pulls write to the Docker root, so
		// a roomy OP_HOME was never evidence the pull would fit. Fails soft: if
		// Docker cannot be asked, the OP_HOME reading still stands.
		const headroom = await checkLifecycleDiskHeadroom(state.homeDir);
		const headroomWarning = describeLifecycleDiskHeadroom(headroom);
		if (headroomWarning) {
			if (shouldBlockOnDiskHeadroom(headroom.worst)) {
				throw new Error(headroomWarning);
			}
			console.warn(`Warning: ${headroomWarning}`);
		}
	}

	await activateComposeCommand(state, composeSubArgs, {
		lock,
		streamTimeoutMs: composeUpTimeoutMs()
	});
}
