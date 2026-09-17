import { defineCommand } from 'citty';
import {
	acquireLeanLock,
	activateLeanComposeCommand,
	buildLeanComposeCliArgs,
	buildLeanComposeOptions,
	composePs,
	createLeanState,
	deactivateLeanComposeCommand,
	ensureDockerReady,
	ensureLeanRuntime,
	ensureStackConfig,
	parseComposePsRows,
	readStackConfig,
	releaseLeanLock,
	requireLeanInstall,
	runComposeStreaming
} from '@openpalm/lib/lean';
import type { LeanState } from '@openpalm/lib/lean';

import { defineAction } from '../lib/action.js';

async function readyState(): Promise<LeanState> {
	const docker = await ensureDockerReady();
	if (!docker.ok) throw new Error(docker.message);
	const state = createLeanState();
	requireLeanInstall(state.homeDir);
	ensureLeanRuntime(state);
	ensureStackConfig(state.homeDir);
	return state;
}

async function withLock(
	state: LeanState,
	action: (lock: NonNullable<ReturnType<typeof acquireLeanLock>>) => Promise<void>
): Promise<void> {
	const lock = acquireLeanLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try {
		await action(lock);
	} finally {
		releaseLeanLock(lock);
	}
}

export async function runStartAction(): Promise<void> {
	const state = await readyState();
	await withLock(state, (lock) =>
		activateLeanComposeCommand(state, ['up', '-d', '--remove-orphans', '--wait'], { lock })
	);
}

export async function runStopAction(): Promise<void> {
	const state = await readyState();
	await withLock(state, (lock) => deactivateLeanComposeCommand(state, { lock }));
}

export async function runRestartAction(): Promise<void> {
	const state = await readyState();
	await withLock(state, (lock) =>
		activateLeanComposeCommand(
			state,
			['up', '-d', '--force-recreate', '--remove-orphans', '--wait'],
			{ lock }
		)
	);
}

export async function runLogsAction(): Promise<void> {
	const state = await readyState();
	const options = buildLeanComposeOptions(state);
	await runComposeStreaming([...buildLeanComposeCliArgs(state), 'logs', '--tail', '100'], {
		envFiles: options.envFiles
	});
}

export async function readStatus(): Promise<Record<string, unknown>> {
	const state = createLeanState();
	requireLeanInstall(state.homeDir);
	ensureLeanRuntime(state);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw new Error(config.error);
	const result = await composePs(buildLeanComposeOptions(state));
	return {
		homeDir: state.homeDir,
		config: config.config,
		services: result.ok ? parseComposePsRows(result.stdout) : [],
		...(result.ok ? {} : { dockerError: result.stderr || 'Docker is unavailable' })
	};
}

export const startCommand = defineCommand({
	meta: { name: 'start', description: 'Start the configured stack' },
	run: defineAction(runStartAction)
});

export const stopCommand = defineCommand({
	meta: { name: 'stop', description: 'Stop the stack without deleting volumes' },
	run: defineAction(runStopAction)
});

export const restartCommand = defineCommand({
	meta: { name: 'restart', description: 'Recreate the configured stack' },
	run: defineAction(runRestartAction)
});

export const logsCommand = defineCommand({
	meta: { name: 'logs', description: 'Print the last 100 service log lines' },
	run: defineAction(runLogsAction)
});

export const statusCommand = defineCommand({
	meta: { name: 'status', description: 'Show stack intent and container status' },
	run: defineAction(async () => console.log(JSON.stringify(await readStatus(), null, 2)))
});
