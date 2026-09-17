import { buildLeanComposeCliArgs, buildLeanComposeOptions } from './lean-compose.js';
import { composeConfigJson, runComposeStreaming } from './lean-docker.js';
import type { LeanState } from './lean-foundation.js';
import { acquireLeanLock, releaseLeanLock, type LeanLock } from './lean-lock.js';
import { auditLeanCompose } from './lean-secret-audit.js';

export async function activateLeanComposeCommand(
	state: LeanState,
	composeArgs: string[],
	options: { lock?: LeanLock | null } = {}
): Promise<void> {
	const lock = options.lock ?? acquireLeanLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const ownsLock = options.lock == null;
	try {
		const composeOptions = buildLeanComposeOptions(state);
		const resolved = await composeConfigJson(composeOptions);
		if (!resolved.ok) {
			throw new Error(`Compose configuration failed: ${resolved.stderr || 'unknown error'}`);
		}
		const issues = auditLeanCompose(resolved.config, state.homeDir);
		if (issues.length > 0) {
			throw new Error(`Refusing Compose activation:\n${issues.join('\n')}`);
		}
		await runComposeStreaming([...buildLeanComposeCliArgs(state), ...composeArgs], {
			envFiles: composeOptions.envFiles
		});
	} finally {
		if (ownsLock) releaseLeanLock(lock);
	}
}

/** Stop the current project without making an unsafe override impossible to contain. */
export async function deactivateLeanComposeCommand(
	state: LeanState,
	options: { lock?: LeanLock | null } = {}
): Promise<void> {
	const lock = options.lock ?? acquireLeanLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const ownsLock = options.lock == null;
	try {
		const composeOptions = buildLeanComposeOptions(state);
		await runComposeStreaming([...buildLeanComposeCliArgs(state), 'down'], {
			envFiles: composeOptions.envFiles
		});
	} finally {
		if (ownsLock) releaseLeanLock(lock);
	}
}
