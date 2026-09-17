import { defineCommand } from 'citty';

import {
	applyLeanHomeSeed,
	classifyLeanInstall,
	createLeanState,
	ensureDockerReady,
	ensureLeanDirs,
	ensureLeanRuntime,
	ensureStackConfig,
	markLeanInstalled,
	parseStackConfig,
	writeStackConfig
} from '@openpalm/lib/lean';

import { seedLeanSkeletonFromEmbedded } from '../lib/embedded-lean-assets.js';
import { runStartAction } from './lifecycle-lean.js';

export type LeanInstallOptions = {
	start: boolean;
	configFile?: string;
};

async function readConfigFile(path: string): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`Stack config file not found: ${path}`);
	try {
		return JSON.parse(await file.text());
	} catch (error) {
		throw new Error(
			`Invalid stack config JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export async function bootstrapLeanInstall(options: LeanInstallOptions): Promise<void> {
	const state = createLeanState();
	if (classifyLeanInstall(state.homeDir) !== 'not_installed') {
		throw new Error('OpenPalm is already installed. Use `openpalm update` to refresh it.');
	}

	if (options.start) {
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
	}

	ensureLeanDirs(state.homeDir);
	await seedLeanSkeletonFromEmbedded(applyLeanHomeSeed, state.homeDir);
	ensureLeanRuntime(state);

	if (options.configFile) {
		const parsed = parseStackConfig(await readConfigFile(options.configFile));
		if (!parsed.ok) throw new Error(parsed.error);
		writeStackConfig(state.homeDir, parsed.config);
	} else {
		ensureStackConfig(state.homeDir);
	}

	// Lean setup has no browser wizard: once its files, credentials, and JSON
	// intent exist, configuration is complete. Runtime health is reported by
	// `start`/`status` independently.
	markLeanInstalled(state.homeDir);

	if (options.start) await runStartAction();
	const configPath = `${state.homeDir}/state/stack.json`;
	console.log(`OpenPalm installed at ${state.homeDir}`);
	console.log(`Stack intent: ${configPath}`);
	console.log(options.start ? 'Assistant started.' : 'Run `openpalm start` when ready.');
}

export default defineCommand({
	meta: {
		name: 'install',
		description: 'Install the lean Assistant stack without a browser wizard'
	},
	args: {
		start: {
			type: 'boolean',
			description: 'Start the stack after writing configuration (use --no-start to skip)',
			default: true
		},
		config: {
			type: 'string',
			alias: 'f',
			description: 'StackConfigV2 JSON file'
		}
	},
	async run({ args }) {
		await bootstrapLeanInstall({
			start: args.start !== false,
			configFile: args.config ? String(args.config) : undefined
		});
	}
});
