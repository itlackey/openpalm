import { existsSync } from 'node:fs';

import { buildComposeArgs, type LeanComposeOptions } from './lean-docker.js';
import {
	customComposeFile,
	managedComposeFile,
	stackEnvFile,
	type LeanState
} from './lean-foundation.js';
import { leanEnabledAddons } from './stack-config.js';

export type { LeanComposeOptions } from './lean-docker.js';

export function buildLeanComposeOptions(state: LeanState): LeanComposeOptions {
	const managed = managedComposeFile(state.homeDir);
	if (!existsSync(managed)) throw new Error(`Managed stack file is missing: ${managed}`);
	const custom = customComposeFile(state.homeDir);
	return {
		files: existsSync(custom) ? [managed, custom] : [managed],
		envFiles: [stackEnvFile(state.homeDir)],
		profiles: leanEnabledAddons(state.homeDir)
	};
}

export function buildLeanComposeCliArgs(state: LeanState): string[] {
	return buildComposeArgs(buildLeanComposeOptions(state));
}
