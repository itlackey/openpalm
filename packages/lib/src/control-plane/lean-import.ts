import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseOAuthConfig, parseOAuthIdentityMap } from './oauth-store.js';
import { parsePortalCredentialMap } from './portal-credential-store.js';
import { readStackConfig } from './stack-config.js';
import { managedComposeFile, stackConfigFile, writeFileAtomic } from './lean-foundation.js';

const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const TASK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/;

export type LeanImportOptions = {
	sourceHome: string;
	destinationHome: string;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};

export type LeanImportAction =
	| 'copy'
	| 'replace-pristine'
	| 'stage-task'
	| 'skip-identical'
	| 'conflict';

export type LeanImportEntry = {
	source: string;
	destination: string;
	relativeSource: string;
	relativeDestination: string;
	category: 'knowledge' | 'task' | 'workspace' | 'config' | 'secret';
	action: LeanImportAction;
	bytes: number;
};

export type LeanImportPlan = {
	version: 1;
	sourceHome: string;
	destinationHome: string;
	entries: LeanImportEntry[];
	warnings: string[];
	totalBytes: number;
	conflicts: number;
	copyCount: number;
};

function realDirectory(path: string, label: string): string {
	const resolved = resolve(path);
	if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
	const stat = lstatSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory: ${resolved}`);
	}
	return realpathSync(resolved);
}

function contained(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function filesBelow(root: string, warnings: string[]): string[] {
	if (!existsSync(root)) return [];
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		warnings.push(`Skipped non-directory import root: ${root}`);
		return [];
	}
	const output: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				warnings.push(`Skipped symlink: ${path}`);
				continue;
			}
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile()) {
				warnings.push(`Skipped non-regular file: ${path}`);
				continue;
			}
			output.push(path);
			if (output.length > MAX_FILES) throw new Error(`Import exceeds ${MAX_FILES} files`);
		}
	}
	return output.sort();
}

function sameBytes(left: string, right: string): boolean {
	if (lstatSync(left).size !== lstatSync(right).size) return false;
	return readFileSync(left).equals(readFileSync(right));
}

function pristineDestination(relativePath: string, path: string): boolean {
	if (!existsSync(path) || !lstatSync(path).isFile()) return false;
	const text = readFileSync(path, 'utf8').trim();
	if (relativePath === 'knowledge/secrets/auth.json') return text === '' || text === '{}';
	if (relativePath === 'knowledge/env/user.env') return text === '';
	if (relativePath === 'config/assistant/opencode.json') {
		try {
			const value = JSON.parse(text) as Record<string, unknown>;
			return Object.keys(value).every((key) => key === '$schema');
		} catch {
			return false;
		}
	}
	if (relativePath === 'config/assistant/persona.md') {
		return text ===
			'# Assistant Persona\n\nDescribe how your personal assistant should communicate, reason, and help you.\nOpenPalm preserves this operator-owned file across updates.';
	}
	if (relativePath === 'config/assistant/user-profile.md') {
		return text ===
			'# About the user\n\nAdd durable context the assistant should know about you: preferences, goals,\nworking style, locale, and recurring responsibilities. Do not store secrets in\nthis file. OpenPalm preserves it across updates.';
	}
	if (relativePath.endsWith('/credentials.json')) {
		try {
			const value = JSON.parse(text) as { version?: unknown; users?: unknown };
			return value.version === 1 && JSON.stringify(value.users) === '{}';
		} catch {
			return false;
		}
	}
	if (relativePath === 'config/guardian/oauth.json') {
		try {
			const value = JSON.parse(text) as { version?: unknown; enabled?: unknown };
			return value.version === 1 && value.enabled === false;
		} catch {
			return false;
		}
	}
	if (relativePath === 'config/guardian/oauth-identities.json') {
		try {
			const value = JSON.parse(text) as { version?: unknown; identities?: unknown };
			return value.version === 1 && Array.isArray(value.identities) && value.identities.length === 0;
		} catch {
			return false;
		}
	}
	return false;
}

function validateMappedConfiguration(relativePath: string, source: string, destinationHome: string): void {
	if (!relativePath.endsWith('.json')) return;
	const value = JSON.parse(readFileSync(source, 'utf8')) as unknown;
	const stack = readStackConfig(destinationHome);
	if (!stack.ok) throw new Error(stack.error);
	if (relativePath.includes('/portal/')) {
		const portal = relativePath.includes('/discord/') ? 'discord' : 'slack';
		const parsed = parsePortalCredentialMap(portal, value);
		for (const username of Object.values(parsed.users)) {
			if (!Object.hasOwn(stack.config.credentials, username)) {
				throw new Error(`${relativePath} references credential ${username}; recreate it before import`);
			}
		}
	}
	if (relativePath.endsWith('/oauth.json')) {
		parseOAuthConfig(value);
	}
	if (relativePath.endsWith('/oauth-identities.json')) {
		const parsed = parseOAuthIdentityMap(value);
		for (const identity of parsed.identities) {
			if (!Object.hasOwn(stack.config.credentials, identity.username)) {
				throw new Error(
					`${relativePath} references credential ${identity.username}; recreate it before import`
				);
			}
		}
	}
}

type Candidate = Omit<LeanImportEntry, 'action' | 'bytes'> & { preferred: LeanImportAction };

function candidate(
	sourceHome: string,
	destinationHome: string,
	source: string,
	destination: string,
	category: LeanImportEntry['category'],
	preferred: LeanImportAction = 'copy'
): Candidate {
	return {
		source,
		destination,
		relativeSource: relative(sourceHome, source).split(sep).join('/'),
		relativeDestination: relative(destinationHome, destination).split(sep).join('/'),
		category,
		preferred
	};
}

function ensureSafeDestinationParent(destinationHome: string, destination: string): void {
	if (!contained(destinationHome, destination)) {
		throw new Error(`Import destination escapes its home: ${destination}`);
	}
	const parentRelative = relative(destinationHome, dirname(destination));
	let current = destinationHome;
	for (const part of parentRelative.split(sep).filter(Boolean)) {
		current = join(current, part);
		if (!existsSync(current)) {
			mkdirSync(current, { mode: 0o700 });
			continue;
		}
		const stat = lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Refusing unsafe import destination directory: ${current}`);
		}
	}
	if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
		throw new Error(`Refusing symlink import destination: ${destination}`);
	}
}

function addTree(
	candidates: Candidate[],
	warnings: string[],
	sourceHome: string,
	destinationHome: string,
	relativeRoot: string,
	category: LeanImportEntry['category'],
	filter: (relativeFile: string) => boolean = () => true
): void {
	const root = join(sourceHome, relativeRoot);
	for (const source of filesBelow(root, warnings)) {
		const file = relative(root, source);
		if (!filter(file)) continue;
		candidates.push(
			candidate(sourceHome, destinationHome, source, join(destinationHome, relativeRoot, file), category)
		);
	}
}

export function planLeanImport(options: LeanImportOptions): LeanImportPlan {
	const sourceHome = realDirectory(options.sourceHome, 'Import source');
	const destinationHome = realDirectory(options.destinationHome, 'Import destination');
	if (sourceHome === destinationHome) throw new Error('Import source and destination must differ');
	if (!existsSync(managedComposeFile(destinationHome)) || !existsSync(stackConfigFile(destinationHome))) {
		throw new Error('Import destination must be a fresh OpenPalm 0.14 installation');
	}

	const warnings: string[] = [];
	const candidates: Candidate[] = [];
	addTree(
		candidates,
		warnings,
		sourceHome,
		destinationHome,
		'knowledge',
		'knowledge',
		(file) => {
			const first = file.split(sep)[0];
			return !['tasks', 'secrets', 'env', '.git', 'node_modules'].includes(first ?? '');
		}
	);
	addTree(candidates, warnings, sourceHome, destinationHome, 'workspace', 'workspace');

	const tasksRoot = join(sourceHome, 'knowledge', 'tasks');
	for (const source of filesBelow(tasksRoot, warnings)) {
		const name = basename(source);
		if (!TASK_FILE_RE.test(name)) {
			warnings.push(`Skipped unsupported task source: ${source}`);
			continue;
		}
		candidates.push(
			candidate(
				sourceHome,
				destinationHome,
				source,
				join(destinationHome, 'knowledge', 'imported-tasks', name),
				'task',
				'stage-task'
			)
		);
	}

	for (const relativePath of [
		'config/assistant/opencode.json',
		'config/assistant/persona.md',
		'config/assistant/user-profile.md'
	]) {
		const source = join(sourceHome, relativePath);
		if (existsSync(source) && lstatSync(source).isFile()) {
			if (relativePath.endsWith('/opencode.json')) {
				const parsed = JSON.parse(readFileSync(source, 'utf8')) as unknown;
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error(`${relativePath} must contain a JSON object`);
				}
			}
			candidates.push(
				candidate(sourceHome, destinationHome, source, join(destinationHome, relativePath), 'config')
			);
		}
	}
	const oldAkm = join(sourceHome, 'config', 'akm');
	for (const source of filesBelow(oldAkm, warnings)) {
		const file = relative(oldAkm, source);
		candidates.push(
			candidate(
				sourceHome,
				destinationHome,
				source,
				join(destinationHome, 'knowledge', 'imported-config', 'akm', file),
				'config'
			)
		);
	}

	if (options.includeProviderAuth) {
		const relativePath = 'knowledge/secrets/auth.json';
		const source = join(sourceHome, relativePath);
		if (existsSync(source) && lstatSync(source).isFile()) {
			candidates.push(
				candidate(sourceHome, destinationHome, source, join(destinationHome, relativePath), 'secret')
			);
		}
	}
	if (options.includeUserEnv) {
		const relativePath = 'knowledge/env/user.env';
		const source = join(sourceHome, relativePath);
		if (existsSync(source) && lstatSync(source).isFile()) {
			candidates.push(
				candidate(sourceHome, destinationHome, source, join(destinationHome, relativePath), 'secret')
			);
		}
	}
	if (options.includePortalMaps) {
		for (const portal of ['discord', 'slack']) {
			const relativePath = `config/portal/${portal}/credentials.json`;
			const source = join(sourceHome, relativePath);
			if (existsSync(source) && lstatSync(source).isFile()) {
				validateMappedConfiguration(relativePath, source, destinationHome);
				candidates.push(
					candidate(sourceHome, destinationHome, source, join(destinationHome, relativePath), 'config')
				);
			}
		}
	}
	if (options.includeOAuth) {
		for (const name of ['oauth.json', 'oauth-identities.json']) {
			const relativePath = `config/guardian/${name}`;
			const source = join(sourceHome, relativePath);
			if (existsSync(source) && lstatSync(source).isFile()) {
				validateMappedConfiguration(relativePath, source, destinationHome);
				candidates.push(
					candidate(sourceHome, destinationHome, source, join(destinationHome, relativePath), 'config')
				);
			}
		}
	}

	let totalBytes = 0;
	const entries: LeanImportEntry[] = [];
	for (const item of candidates) {
		const stat = lstatSync(item.source);
		if (!stat.isFile() || stat.isSymbolicLink()) continue;
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Import file is too large: ${item.source}`);
		totalBytes += stat.size;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Import exceeds the 20 GiB safety limit');
		let action = item.preferred;
		if (existsSync(item.destination)) {
			if (!lstatSync(item.destination).isFile()) action = 'conflict';
			else if (sameBytes(item.source, item.destination)) action = 'skip-identical';
			else if (pristineDestination(item.relativeDestination, item.destination)) {
				action = 'replace-pristine';
			} else action = 'conflict';
		}
		entries.push({ ...item, action, bytes: stat.size });
	}

	return {
		version: 1,
		sourceHome,
		destinationHome,
		entries,
		warnings,
		totalBytes,
		conflicts: entries.filter((entry) => entry.action === 'conflict').length,
		copyCount: entries.filter((entry) => !['conflict', 'skip-identical'].includes(entry.action)).length
	};
}

export function applyLeanImport(options: LeanImportOptions): LeanImportPlan {
	const plan = planLeanImport(options);
	if (plan.conflicts > 0) {
		throw new Error(
			`Import has ${plan.conflicts} destination conflict(s). Resolve them and run --dry-run again.`
		);
	}
	for (const entry of plan.entries) {
		if (entry.action === 'skip-identical') continue;
		const sourceReal = realpathSync(entry.source);
		if (!contained(plan.sourceHome, sourceReal) || !lstatSync(sourceReal).isFile()) {
			throw new Error(`Import source changed or escaped its home: ${entry.source}`);
		}
		const mode = (lstatSync(sourceReal).mode & 0o111) !== 0 ? 0o700 : 0o600;
		ensureSafeDestinationParent(plan.destinationHome, entry.destination);
		writeFileAtomic(entry.destination, readFileSync(sourceReal), mode);
	}
	return plan;
}
