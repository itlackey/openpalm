import { copyFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureLeanDirs } from './lean-foundation.js';

export const LEAN_MANAGED_FILES = [
	'system/stack/stack.compose.yml',
	'system/assistant/.gitignore',
	'system/assistant/opencode.jsonc',
	'system/assistant/AGENTS.md',
	'system/assistant/agents/remote.md',
	'system/assistant/agents/remote-read.md',
	'system/assistant/agents/remote-full.md',
	'system/assistant/plugins/akm.js',
	'system/guardian/.gitignore',
	'system/guardian/opencode.jsonc',
	'system/guardian/instructions/moderation.md'
] as const;

export const LEAN_SEEDED_FILES = [
	'config/stack/custom.compose.yml',
	'config/assistant/.gitignore',
	'config/assistant/opencode.json',
	'config/guardian/.gitignore',
	'config/guardian/opencode.json',
	'config/portal/discord/credentials.json',
	'config/portal/slack/credentials.json',
	'knowledge/env/user.env'
] as const;

function skeletonRoot(): string {
	if (process.env.OPENPALM_SKELETON_DIR) return process.env.OPENPALM_SKELETON_DIR;
	if (process.env.OPENPALM_REPO_ROOT) {
		return join(process.env.OPENPALM_REPO_ROOT, 'packages', 'skeleton');
	}
	const candidate = join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'..',
		'..',
		'packages',
		'skeleton'
	);
	if (existsSync(join(candidate, 'system', 'stack', 'stack.compose.yml'))) return candidate;
	throw new Error(
		'OpenPalm skeleton assets were not found. Set OPENPALM_SKELETON_DIR or OPENPALM_REPO_ROOT.'
	);
}

function copy(
	sourceRoot: string,
	homeDir: string,
	relativePath: string,
	overwrite: boolean
): boolean {
	const source = join(sourceRoot, relativePath);
	const destination = join(homeDir, relativePath);
	if (!existsSync(source)) throw new Error(`Required skeleton asset is missing: ${relativePath}`);
	if (!overwrite && existsSync(destination)) return false;
	if (overwrite && existsSync(destination) && !lstatSync(destination).isFile()) {
		throw new Error(`Refusing to replace non-file managed path: ${destination}`);
	}
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
	return true;
}

/**
 * Materialize only the lean release surface. Managed files are replaced as
 * whole files; user-owned seed files are never overwritten. No stale path is
 * removed automatically, which keeps upgrades from deleting operator data.
 */
export async function applyLeanHomeSeed(homeDir: string): Promise<{ updated: string[] }> {
	ensureLeanDirs(homeDir);
	const source = skeletonRoot();
	const updated: string[] = [];
	for (const path of LEAN_MANAGED_FILES) {
		if (copy(source, homeDir, path, true)) updated.push(path);
	}
	for (const path of LEAN_SEEDED_FILES) {
		if (copy(source, homeDir, path, false)) updated.push(path);
	}
	return { updated };
}
