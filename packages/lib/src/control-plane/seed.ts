import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureHomeDirs, writeFileAtomic } from './foundation.js';

export const MANAGED_FILES = [
	'system/stack/stack.compose.yml',
	'system/assistant/.gitignore',
	'system/assistant/opencode.jsonc',
	'system/assistant/AGENTS.md',
	'system/assistant/agents/remote.md',
	'system/assistant/agents/remote-read.md',
	'system/assistant/agents/remote-full.md',
	'system/assistant/agents/scheduled.md',
	'system/assistant/agents/memory.md',
	'system/assistant/lib/memory.js',
	'system/assistant/plugins/akm.js',
	'system/guardian/.gitignore',
	'system/guardian/opencode.jsonc',
	'system/guardian/instructions/moderation.md'
] as const;

export const SEEDED_FILES = [
	'config/stack/custom.compose.yml',
	'config/assistant/.gitignore',
	'config/assistant/opencode.json',
	'config/assistant/persona.md',
	'config/assistant/user-profile.md',
	'config/akm/config.json',
	'config/guardian/.gitignore',
	'config/guardian/opencode.json',
	'config/guardian/oauth.json',
	'config/guardian/oauth-identities.json',
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
	const sourceStat = lstatSync(source, { throwIfNoEntry: false });
	if (!sourceStat?.isFile()) {
		throw new Error(`Required skeleton asset is missing or invalid: ${relativePath}`);
	}
	const parentPath = dirname(destination);
	const parentRelative = relative(homeDir, parentPath);
	if (
		parentRelative === '..' ||
		parentRelative.startsWith(`..${sep}`) ||
		isAbsolute(parentRelative)
	) {
		throw new Error(`Skeleton destination escapes OP_HOME: ${destination}`);
	}
	let current = homeDir;
	for (const segment of parentRelative.split(sep).filter(Boolean)) {
		current = join(current, segment);
		let stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) {
			mkdirSync(current, { mode: 0o700 });
			stat = lstatSync(current);
		}
		if (!stat.isDirectory()) {
			throw new Error(`Refusing non-directory or symlink seed path: ${current}`);
		}
	}
	const destinationStat = lstatSync(destination, { throwIfNoEntry: false });
	if (destinationStat) {
		if (!destinationStat.isFile()) {
			throw new Error(`Refusing to replace non-file seed path: ${destination}`);
		}
		if (!overwrite) return false;
	}
	writeFileAtomic(destination, readFileSync(source), sourceStat.mode & 0o777);
	return true;
}

/**
 * Materialize only the release surface. Managed files are replaced as
 * whole files; user-owned seed files are never overwritten. No stale path is
 * removed automatically, which keeps upgrades from deleting operator data.
 */
export async function applyHomeSeed(homeDir: string): Promise<{ updated: string[] }> {
	ensureHomeDirs(homeDir);
	const source = skeletonRoot();
	const updated: string[] = [];
	for (const path of MANAGED_FILES) {
		if (copy(source, homeDir, path, true)) updated.push(path);
	}
	for (const path of SEEDED_FILES) {
		if (copy(source, homeDir, path, false)) updated.push(path);
	}
	return { updated };
}
