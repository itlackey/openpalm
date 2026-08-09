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
	if (!lock) throw new Error('install_in_progress: Another install or update is already running.');
	const ownsLock = activation.lock == null;
	try {
		const options = activation.composeOptions ?? buildComposeOptions(state);
		// Async on purpose: this runs on every admin-UI compose action, and the
		// sync variant's execFileSync would block the whole event loop for the
		// subprocess duration.
		const resolved = await composeConfigJson(options);
		if (!resolved.ok || !resolved.config) {
			throw new Error(
				`Compose ${operation} configuration resolution failed: ${resolved.stderr || 'unknown error'}`
			);
		}
		const result = auditFileBasedSecrets({
			stackEnvPath: stackEnvPath(state),
			composeConfig: resolved.config,
			homeDir: state.homeDir,
			secretsDir: `${state.homeDir}/knowledge/secrets`,
			privateSecretsDir: `${state.homeDir}/private/secrets`
		});
		if (!result.ok) {
			throw activationError(
				operation,
				result.issues.map(
					(entry) => `${entry.code}: ${entry.message}${entry.path ? ` (${entry.path})` : ''}`
				)
			);
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
