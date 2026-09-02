import type { ControlPlaneState } from './types.js';
import { buildComposeOptions, type ComposeOptions } from './compose-args.js';
import {
	applyStack,
	buildComposeCommandArgs,
	composeConfigJson,
	runComposeStreaming,
	type ApplyStackOptions,
	type ApplyStackResult,
	type ApplyStackScope
} from './docker.js';
import { acquireInstallLock, releaseInstallLock, type InstallLockHandle } from './install-lock.js';
import { stackEnvPath } from './paths.js';
import { auditFileBasedSecrets } from './secret-audit.js';

export type ComposeActivationOptions = {
	lock?: InstallLockHandle | null;
	streamTimeoutMs?: number;
	composeOptions?: ComposeOptions;
};

function activationError(operation: string, issues: string[]): Error {
	return new Error(
		`Refusing Compose ${operation}: secret-boundary audit failed.\n${issues.join('\n')}`
	);
}

// ── Pre-mutation refusal marker (#664) ───────────────────────────────────────
//
// Everything in `runComposeActivation` up to (not including) the `mutate(...)`
// call below — acquiring the lock, resolving `compose config`, the
// secret-boundary audit — runs BEFORE any Docker pull/up is attempted. A
// caller (performUpgrade's snapshot-rollback wrapper) that treats every
// activation failure the same re-tags the still-untouched running images and
// re-pins `state/stack.env` to a synthetic `rollback-<generation>` value even
// though nothing was ever deployed. Tagging the error thrown from any of
// those pre-`mutate` paths lets that caller tell "refused before touching
// Docker" apart from "Docker was actually invoked and failed partway", so it
// can skip the image-preservation step precisely when there is nothing to
// preserve. Deliberately a marker on the thrown Error, not a new error class:
// every throw site already constructs a plain `Error` with a specific
// message callers match on elsewhere (install.ts's `startsWith('Refusing
// Compose')`), and this adds one fact without disturbing that.
const PRE_MUTATION_REFUSAL = Symbol('openpalm.preMutationRefusal');

export function markPreMutationRefusal<E>(error: E): E {
	if (error && typeof error === 'object') {
		Object.defineProperty(error, PRE_MUTATION_REFUSAL, { value: true, enumerable: false, configurable: true });
	}
	return error;
}

/** True when `error` was thrown before `runComposeActivation` ever called `mutate` — i.e. before any Docker pull/up was attempted. */
export function isPreMutationRefusal(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[PRE_MUTATION_REFUSAL] === true);
}

/**
 * Mandatory gate for every host-side Compose activation. The audit deliberately
 * runs against Compose's JSON-resolved project, not an individual overlay, so
 * native merge, include/extends, interpolation, profiles, and source overrides
 * cannot evade the boundary.
 */
export async function runComposeActivation<T>(
	state: ControlPlaneState,
	operation: string,
	mutate: (options: ComposeOptions) => Promise<T>,
	activation: ComposeActivationOptions = {}
): Promise<T> {
	const lock = activation.lock ?? acquireInstallLock(state.dataDir);
	if (!lock) {
		throw markPreMutationRefusal(new Error('install_in_progress: Another install or update is already running.'));
	}
	const ownsLock = activation.lock == null;
	try {
		const options = activation.composeOptions ?? buildComposeOptions(state);
		// Async on purpose: this runs on every admin-UI compose action, and the
		// sync variant's execFileSync would block the whole event loop for the
		// subprocess duration.
		const resolved = await composeConfigJson(options);
		if (!resolved.ok || !resolved.config) {
			throw markPreMutationRefusal(new Error(
				`Compose ${operation} configuration resolution failed: ${resolved.stderr || 'unknown error'}`
			));
		}
		const result = auditFileBasedSecrets({
			stackEnvPath: stackEnvPath(state),
			composeConfig: resolved.config,
			homeDir: state.homeDir,
			secretsDir: `${state.homeDir}/knowledge/secrets`,
			stateSecretsDir: `${state.homeDir}/state/secrets`
		});
		if (!result.ok) {
			throw markPreMutationRefusal(activationError(
				operation,
				result.issues.map(
					(entry) => `${entry.code}: ${entry.message}${entry.path ? ` (${entry.path})` : ''}`
				)
			));
		}
		return await mutate(options);
	} finally {
		if (ownsLock) releaseInstallLock(lock);
	}
}

export function activateStack(
	state: ControlPlaneState,
	scope: ApplyStackScope,
	applyOptions: ApplyStackOptions = {},
	activation: ComposeActivationOptions = {}
): Promise<ApplyStackResult> {
	return runComposeActivation(
		state,
		'stack activation',
		(options) => applyStack(scope, options, undefined, applyOptions),
		activation
	);
}

export function activateComposeCommand(
	state: ControlPlaneState,
	composeArgs: string[],
	activation: ComposeActivationOptions = {}
): Promise<void> {
	return runComposeActivation(
		state,
		composeArgs[0] ?? 'mutation',
		async (options) => {
			await runComposeStreaming([...buildComposeCommandArgs(options), ...composeArgs], {
				timeoutMs: activation.streamTimeoutMs
			});
		},
		activation
	);
}
