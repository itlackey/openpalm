import type { ControlPlaneState } from './types.js';
import { buildComposeOptions, type ComposeOptions } from './compose-args.js';
import {
	applyStack,
	buildComposeCommandArgs,
	composeConfigJsonSync,
	runComposeStreaming,
	type ApplyStackOptions,
	type ApplyStackResult,
	type ApplyStackScope
} from './docker.js';
import { acquireInstallLock, releaseInstallLock, type InstallLockHandle } from './install-lock.js';

export type ComposeActivationOptions = {
	lock?: InstallLockHandle | null;
	streamTimeoutMs?: number;
	composeOptions?: ComposeOptions;
};

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
		const resolved = composeConfigJsonSync(options);
		if (!resolved.ok || !resolved.config) {
			throw new Error(
				`Compose ${operation} configuration resolution failed: ${resolved.stderr || 'unknown error'}`
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
