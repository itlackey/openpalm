import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeConfigJson, runComposeStreaming } from './docker.js';
import type { OpenPalmState } from './foundation.js';
import { acquireStackLock, releaseStackLock, type StackLock } from './lock.js';
import { auditCompose } from './secret-audit.js';

export async function activateComposeCommand(
	state: OpenPalmState,
	composeArgs: string[],
	options: { lock?: StackLock | null } = {}
): Promise<void> {
	const lock = options.lock ?? acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const ownsLock = options.lock == null;
	try {
		const composeOptions = buildComposeOptions(state);
		const resolved = await composeConfigJson(composeOptions);
		if (!resolved.ok) {
			throw new Error(`Compose configuration failed: ${resolved.stderr || 'unknown error'}`);
		}
		const issues = auditCompose(resolved.config, state.homeDir);
		if (issues.length > 0) {
			throw new Error(`Refusing Compose activation:\n${issues.join('\n')}`);
		}
		await runComposeStreaming([...buildComposeCliArgs(state), ...composeArgs], {
			envFiles: composeOptions.envFiles
		});
	} finally {
		if (ownsLock) releaseStackLock(lock);
	}
}

/** Stop the current project without making an unsafe override impossible to contain. */
export async function deactivateComposeCommand(
	state: OpenPalmState,
	options: { lock?: StackLock | null } = {}
): Promise<void> {
	const lock = options.lock ?? acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const ownsLock = options.lock == null;
	try {
		const composeOptions = buildComposeOptions(state);
		await runComposeStreaming([...buildComposeCliArgs(state), 'down'], {
			envFiles: composeOptions.envFiles
		});
	} finally {
		if (ownsLock) releaseStackLock(lock);
	}
}
