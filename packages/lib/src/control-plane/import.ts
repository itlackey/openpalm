import { createHash } from 'node:crypto';
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseOAuthConfig, parseOAuthIdentityMap } from './oauth-store.js';
import { parsePortalCredentialMap } from './portal-credential-store.js';
import { readStackConfig } from './stack-config.js';
import { managedComposeFile, stackConfigFile, writeFileAtomic } from './foundation.js';
import {
	assertSafePortablePath,
	hasInlineProviderCredentials,
	hasNonPortableNativeConfiguration,
	providerSecretFiles,
	readProviderSecretFile
} from './provider-files.js';

const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const TASK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/;

export type ImportOptions = {
	sourceHome: string;
	destinationHome: string;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};

export type ImportAction =
	| 'copy'
	| 'replace-pristine'
	| 'stage-task'
	| 'skip-identical'
	| 'conflict';

export type ImportEntry = {
	source: string;
	destination: string;
	relativeSource: string;
	relativeDestination: string;
	category: 'knowledge' | 'task' | 'workspace' | 'config' | 'secret';
	action: ImportAction;
	bytes: number;
	sha256: string;
};

export type ImportPlan = {
	version: 1;
	sourceHome: string;
	destinationHome: string;
	entries: ImportEntry[];
	warnings: string[];
	totalBytes: number;
	conflicts: number;
	copyCount: number;
	digest: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readRegularSource(
	path: string,
	maximum = MAX_FILE_BYTES
): { bytes: Buffer; mode: number } {
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new Error(`Import source is not a regular file: ${path}`);
		if (stat.size > maximum) throw new Error(`Import file is too large: ${path}`);
		return { bytes: readFileSync(descriptor), mode: stat.mode };
	} finally {
		closeSync(descriptor);
	}
}

function verifyBackupManifest(sourceHome: string): Set<string> | null {
	const path = join(sourceHome, 'openpalm-backup.json');
	if (!existsSync(path)) return null;
	let value: unknown;
	try {
		value = JSON.parse(
			readRegularSource(path, MAX_MANIFEST_BYTES).bytes.toString('utf8')
		) as unknown;
	} catch {
		throw new Error('Backup manifest is invalid or unreadable');
	}
	const root = asRecord(value);
	if (root?.version !== 1 || !Array.isArray(root.files) || root.files.length > MAX_FILES) {
		throw new Error('Backup manifest must use version 1 with a bounded file list');
	}
	const verified = new Set<string>();
	let totalBytes = 0;
	for (const rawEntry of root.files) {
		const entry = asRecord(rawEntry);
		if (
			!entry ||
			typeof entry.path !== 'string' ||
			!Number.isSafeInteger(entry.bytes) ||
			(entry.bytes as number) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(entry.sha256)
		) {
			throw new Error('Backup manifest contains an invalid file entry');
		}
		const parts = entry.path.split('/');
		if (
			entry.path.includes('\\') ||
			parts.some((part) => !part || part === '.' || part === '..') ||
			isAbsolute(entry.path) ||
			verified.has(entry.path)
		) {
			throw new Error(`Backup manifest contains an unsafe or duplicate path: ${entry.path}`);
		}
		const source = join(sourceHome, ...parts);
		if (!contained(sourceHome, source)) {
			throw new Error(`Backup manifest path escaped its source: ${entry.path}`);
		}
		assertSafePortablePath(sourceHome, entry.path);
		const file = readRegularSource(source);
		if (file.bytes.byteLength !== entry.bytes) {
			throw new Error(`Backup size mismatch: ${entry.path}`);
		}
		const digest = createHash('sha256').update(file.bytes).digest('hex');
		if (digest !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}`);
		totalBytes += file.bytes.byteLength;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Backup exceeds the 20 GiB safety limit');
		verified.add(entry.path);
	}
	if (!Number.isSafeInteger(root.totalBytes) || root.totalBytes !== totalBytes) {
		throw new Error('Backup manifest total size does not match its files');
	}
	return verified;
}

function filesBelow(
	root: string,
	warnings: string[],
	skipDirectory: (path: string) => boolean = () => false
): string[] {
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
			if ((entry.isDirectory() || entry.isSymbolicLink()) && skipDirectory(path)) continue;
			if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name === 'node_modules') {
				warnings.push(
					`Skipped generated dependencies: ${path}; reinstall dependencies after import.`
				);
				continue;
			}
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

function sameBytes(path: string, bytes: Buffer): boolean {
	if (lstatSync(path).size !== bytes.byteLength) return false;
	return readRegularSource(path).bytes.equals(bytes);
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
		return (
			text ===
			'# Assistant Persona\n\nDescribe how your personal assistant should communicate, reason, and help you.\nOpenPalm preserves this operator-owned file across updates.'
		);
	}
	if (relativePath === 'config/assistant/user-profile.md') {
		return (
			text ===
			'# About the user\n\nAdd durable context the assistant should know about you: preferences, goals,\nworking style, locale, and recurring responsibilities. Do not store secrets in\nthis file. OpenPalm preserves it across updates.'
		);
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
			return (
				value.version === 1 && Array.isArray(value.identities) && value.identities.length === 0
			);
		} catch {
			return false;
		}
	}
	return false;
}

function validateMappedConfiguration(
	relativePath: string,
	source: string,
	destinationHome: string
): void {
	if (!relativePath.endsWith('.json')) return;
	let value: unknown;
	try {
		value = JSON.parse(readRegularSource(source).bytes.toString('utf8')) as unknown;
	} catch {
		throw new Error(`${relativePath} must contain valid JSON; no configuration values were logged`);
	}
	const stack = readStackConfig(destinationHome);
	if (!stack.ok) throw new Error(stack.error);
	if (relativePath.includes('/portal/')) {
		const portal = relativePath.includes('/discord/') ? 'discord' : 'slack';
		const parsed = parsePortalCredentialMap(portal, value);
		for (const username of Object.values(parsed.users)) {
			if (!Object.hasOwn(stack.config.credentials, username)) {
				throw new Error(
					`${relativePath} references credential ${username}; recreate it before import`
				);
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

type Candidate = Omit<ImportEntry, 'action' | 'bytes' | 'sha256'> & {
	preferred: ImportAction;
};

function candidate(
	sourceHome: string,
	destinationHome: string,
	source: string,
	destination: string,
	category: ImportEntry['category'],
	preferred: ImportAction = 'copy'
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
	category: ImportEntry['category'],
	filter: (relativeFile: string) => boolean = () => true,
	skipDirectory: (path: string) => boolean = () => false
): void {
	const root = join(sourceHome, relativeRoot);
	assertSafePortablePath(sourceHome, relativeRoot, true);
	for (const source of filesBelow(root, warnings, skipDirectory)) {
		const file = relative(root, source);
		if (!filter(file)) continue;
		candidates.push(
			candidate(
				sourceHome,
				destinationHome,
				source,
				join(destinationHome, relativeRoot, file),
				category
			)
		);
	}
}

export function planImport(options: ImportOptions): ImportPlan {
	const sourceHome = realDirectory(options.sourceHome, 'Import source');
	const destinationHome = realDirectory(options.destinationHome, 'Import destination');
	const verifiedBackupFiles = verifyBackupManifest(sourceHome);
	if (sourceHome === destinationHome) throw new Error('Import source and destination must differ');
	if (
		!existsSync(managedComposeFile(destinationHome)) ||
		!existsSync(stackConfigFile(destinationHome))
	) {
		throw new Error('Import destination must be a fresh OpenPalm 0.14 installation');
	}

	const warnings: string[] = [];
	const candidates: Candidate[] = [];
	const knowledgeRoot = join(sourceHome, 'knowledge');
	addTree(
		candidates,
		warnings,
		sourceHome,
		destinationHome,
		'knowledge',
		'knowledge',
		(file) => {
			const first = file.split(sep)[0];
			return !['tasks', 'secrets', 'env', '.git', '.akm'].includes(first ?? '');
		},
		(path) => {
			const relativePath = relative(knowledgeRoot, path).split(sep).join('/');
			if (relativePath === 'imported-config/akm') {
				warnings.push(
					'Skipped historical AKM staging (knowledge/imported-config/akm): it may contain credentials. Source preserved.'
				);
				return true;
			}
			if (relativePath === '.akm') {
				warnings.push(
					'Skipped generated AKM metadata (knowledge/.akm): the fresh installation regenerates its indexes and runtime metadata. Source preserved.'
				);
				return true;
			}
			return ['tasks', 'secrets', 'env', '.git'].includes(relativePath);
		}
	);
	addTree(candidates, warnings, sourceHome, destinationHome, 'workspace', 'workspace');

	const tasksRoot = join(sourceHome, 'knowledge', 'tasks');
	assertSafePortablePath(sourceHome, 'knowledge/tasks', true);
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

	let nonPortableNativeConfiguration = false;
	for (const relativePath of [
		'config/assistant/opencode.json',
		'config/assistant/persona.md',
		'config/assistant/user-profile.md'
	]) {
		const source = join(sourceHome, relativePath);
		assertSafePortablePath(sourceHome, relativePath, true);
		if (existsSync(source) && lstatSync(source).isFile()) {
			if (relativePath.endsWith('/opencode.json')) {
				nonPortableNativeConfiguration = hasNonPortableNativeConfiguration(sourceHome);
				if (nonPortableNativeConfiguration) {
					warnings.push(
						'Skipped non-portable native OpenCode configuration: only $schema, model, small_model and provider are portable. Review and recreate other customization separately; source preserved.'
					);
					continue;
				}
				if (hasInlineProviderCredentials(sourceHome) && !options.includeProviderAuth) {
					warnings.push(
						'Skipped native OpenCode configuration containing inline provider credentials: explicitly opt in with --include-provider-auth or sign in again. Source preserved.'
					);
					continue;
				}
			}
			candidates.push(
				candidate(
					sourceHome,
					destinationHome,
					source,
					join(destinationHome, relativePath),
					'config'
				)
			);
		}
	}
	const oldAkm = join(sourceHome, 'config', 'akm');
	if (existsSync(oldAkm)) {
		warnings.push(
			'Skipped historical AKM configuration (config/akm): it may contain credentials; recreate supported settings in the fresh installation. Source preserved.'
		);
	}

	let providerFiles: string[] = [];
	try {
		if (!nonPortableNativeConfiguration) providerFiles = providerSecretFiles(sourceHome);
	} catch (error) {
		if (options.includeProviderAuth) throw error;
		warnings.push(
			'Provider file references could not be safely imported; configure the provider again or review references before opting in to --include-provider-auth.'
		);
	}
	if (!options.includeProviderAuth && providerFiles.length) {
		warnings.push(
			`Excluded ${providerFiles.length} referenced private provider file(s): use --include-provider-auth or configure the provider again before setup.`
		);
	}
	if (options.includeProviderAuth) {
		const authPath = 'knowledge/secrets/auth.json';
		assertSafePortablePath(sourceHome, authPath, true);
		if (existsSync(join(sourceHome, authPath))) providerFiles.push(authPath);
		for (const relativePath of new Set(providerFiles)) {
			const source = join(sourceHome, relativePath);
			readProviderSecretFile(sourceHome, relativePath);
			assertSafePortablePath(destinationHome, relativePath, true);
			candidates.push(
				candidate(
					sourceHome,
					destinationHome,
					source,
					join(destinationHome, relativePath),
					'secret'
				)
			);
		}
	}
	if (options.includeUserEnv) {
		const relativePath = 'knowledge/env/user.env';
		const source = join(sourceHome, relativePath);
		if (existsSync(source) && lstatSync(source).isFile()) {
			candidates.push(
				candidate(
					sourceHome,
					destinationHome,
					source,
					join(destinationHome, relativePath),
					'secret'
				)
			);
		}
	}
	if (options.includePortalMaps) {
		for (const portal of ['discord', 'slack']) {
			const relativePath = `config/portal/${portal}/credentials.json`;
			const source = join(sourceHome, relativePath);
			assertSafePortablePath(sourceHome, relativePath, true);
			if (existsSync(source) && lstatSync(source).isFile()) {
				validateMappedConfiguration(relativePath, source, destinationHome);
				candidates.push(
					candidate(
						sourceHome,
						destinationHome,
						source,
						join(destinationHome, relativePath),
						'config'
					)
				);
			}
		}
	}
	if (options.includeOAuth) {
		for (const name of ['oauth.json', 'oauth-identities.json']) {
			const relativePath = `config/guardian/${name}`;
			const source = join(sourceHome, relativePath);
			assertSafePortablePath(sourceHome, relativePath, true);
			if (existsSync(source) && lstatSync(source).isFile()) {
				validateMappedConfiguration(relativePath, source, destinationHome);
				candidates.push(
					candidate(
						sourceHome,
						destinationHome,
						source,
						join(destinationHome, relativePath),
						'config'
					)
				);
			}
		}
	}

	if (candidates.length > MAX_FILES)
		throw new Error(`Import exceeds ${MAX_FILES} files across all categories`);
	let totalBytes = 0;
	const entries: ImportEntry[] = [];
	for (const item of candidates) {
		assertSafePortablePath(sourceHome, item.relativeSource);
		assertSafePortablePath(destinationHome, item.relativeDestination, true);
		if (verifiedBackupFiles && !verifiedBackupFiles.has(item.relativeSource)) {
			throw new Error(`Backup file is not recorded in its manifest: ${item.relativeSource}`);
		}
		const stat = lstatSync(item.source);
		if (!stat.isFile() || stat.isSymbolicLink()) continue;
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Import file is too large: ${item.source}`);
		const sourceFile =
			item.category === 'secret' && item.relativeSource.startsWith('knowledge/secrets/')
				? { bytes: readProviderSecretFile(sourceHome, item.relativeSource), mode: stat.mode }
				: readRegularSource(item.source);
		totalBytes += sourceFile.bytes.byteLength;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Import exceeds the 20 GiB safety limit');
		let action = item.preferred;
		if (existsSync(item.destination)) {
			if (!lstatSync(item.destination).isFile()) action = 'conflict';
			else if (sameBytes(item.destination, sourceFile.bytes)) action = 'skip-identical';
			else if (pristineDestination(item.relativeDestination, item.destination)) {
				action = 'replace-pristine';
			} else action = 'conflict';
		}
		const { preferred: _preferred, ...entry } = item;
		entries.push({
			...entry,
			action,
			bytes: sourceFile.bytes.byteLength,
			sha256: createHash('sha256').update(sourceFile.bytes).digest('hex')
		});
	}

	const result: Omit<ImportPlan, 'digest'> = {
		version: 1,
		sourceHome,
		destinationHome,
		entries,
		warnings,
		totalBytes,
		conflicts: entries.filter((entry) => entry.action === 'conflict').length,
		copyCount: entries.filter((entry) => !['conflict', 'skip-identical'].includes(entry.action))
			.length
	};
	return {
		...result,
		digest: createHash('sha256').update(JSON.stringify(result)).digest('hex')
	};
}

export function applyImport(options: ImportOptions, expectedDigest?: string): ImportPlan {
	const plan = planImport(options);
	if (expectedDigest !== undefined && plan.digest !== expectedDigest) {
		throw new Error('The restore source or destination changed after preview. Preview it again.');
	}
	if (plan.conflicts > 0) {
		throw new Error(
			`Import has ${plan.conflicts} destination conflict(s). Resolve them and run --dry-run again.`
		);
	}
	for (const entry of plan.entries) {
		if (entry.action === 'skip-identical') continue;
		assertSafePortablePath(plan.sourceHome, entry.relativeSource);
		const sourceReal = realpathSync(entry.source);
		if (!contained(plan.sourceHome, sourceReal)) {
			throw new Error(`Import source changed or escaped its home: ${entry.source}`);
		}
		const sourceFile =
			entry.category === 'secret' && entry.relativeSource.startsWith('knowledge/secrets/')
				? { bytes: readProviderSecretFile(plan.sourceHome, entry.relativeSource), mode: 0o600 }
				: readRegularSource(entry.source);
		const digest = createHash('sha256').update(sourceFile.bytes).digest('hex');
		if (digest !== entry.sha256) {
			throw new Error(`Import source changed after preview: ${entry.relativeSource}`);
		}
		const mode = entry.category !== 'secret' && (sourceFile.mode & 0o111) !== 0 ? 0o700 : 0o600;
		ensureSafeDestinationParent(plan.destinationHome, entry.destination);
		writeFileAtomic(entry.destination, sourceFile.bytes, mode);
	}
	return plan;
}
