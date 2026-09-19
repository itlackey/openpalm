import { existsSync } from 'node:fs';

import { buildComposeArgs, type ComposeOptions } from './docker.js';
import {
	customComposeFile,
	managedComposeFile,
	stackEnvFile,
	type OpenPalmState
} from './foundation.js';
import { enabledAddons } from './stack-config.js';

export type { ComposeOptions } from './docker.js';

export function buildComposeOptions(state: OpenPalmState): ComposeOptions {
	const managed = managedComposeFile(state.homeDir);
	if (!existsSync(managed)) throw new Error(`Managed stack file is missing: ${managed}`);
	const custom = customComposeFile(state.homeDir);
	return {
		files: existsSync(custom) ? [managed, custom] : [managed],
		envFiles: [stackEnvFile(state.homeDir)],
		profiles: enabledAddons(state.homeDir)
	};
}

export function buildComposeCliArgs(state: OpenPalmState): string[] {
	return buildComposeArgs(buildComposeOptions(state));
}
