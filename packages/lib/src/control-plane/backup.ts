import { createHash } from 'node:crypto';
import {
	chmodSync,
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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readStackConfig } from './stack-config.js';
import {
	inspectUnrestoredData,
	PORTABLE_BACKUP_EXCLUSIONS,
	type PreservationItem
} from './preservation.js';
import { writeFileAtomic } from './foundation.js';
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

export type BackupOptions = {
	sourceHome: string;
	destination: string;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};

export type BackupManifest = {
	version: 1;
	scope: 'portable';
	excludedCategories: string[];
	preservation: PreservationItem[];
	createdAt: string;
	sourceVersion: number;
	stackConfig: unknown;
	options: {
		providerAuth: boolean;
		userEnv: boolean;
		portalMaps: boolean;
		oauth: boolean;
	};
	files: Array<{ path: string; bytes: number; sha256: string }>;
	warnings: string[];
	totalBytes: number;
};

function contained(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function sourceRoot(path: string): string {
	const resolved = resolve(path);
	if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
		throw new Error(`Backup source is not a directory: ${resolved}`);
	}
	return realpathSync(resolved);
}

function prepareDestination(path: string, source: string): string {
	const destination = resolve(path);
	if (contained(source, destination)) {
		throw new Error('Backup destination must be outside OP_HOME.');
	}
	if (existsSync(destination)) {
		if (!lstatSync(destination).isDirectory()) {
			throw new Error(`Backup destination is not a directory: ${destination}`);
		}
		if (contained(source, realpathSync(destination))) {
			throw new Error('Backup destination must not resolve inside OP_HOME.');
		}
		if (readdirSync(destination).length > 0) {
			throw new Error(`Backup destination must be empty: ${destination}`);
		}
	} else {
		let ancestor = dirname(destination);
		while (!existsSync(ancestor)) {
			const parent = dirname(ancestor);
			if (parent === ancestor)
				throw new Error(`Could not resolve backup destination: ${destination}`);
			ancestor = parent;
		}
		if (!lstatSync(ancestor).isDirectory()) {
			throw new Error(`Backup destination parent must be a real directory: ${ancestor}`);
		}
		const prospective = resolve(realpathSync(ancestor), relative(ancestor, destination));
		if (contained(source, prospective)) {
			throw new Error('Backup destination must not resolve inside OP_HOME.');
		}
		mkdirSync(destination, { recursive: true, mode: 0o700 });
	}
	const realized = realpathSync(destination);
	if (contained(source, realized)) {
		throw new Error('Backup destination must not resolve inside OP_HOME.');
	}
	chmodSync(realized, 0o700);
	return realized;
}

function readSourceFile(home: string, relativePath: string): { bytes: Buffer; mode: number } {
	assertSafePortablePath(home, relativePath);
	const path = join(home, relativePath);
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new Error(`Backup source is not a regular file: ${path}`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Backup file is too large: ${path}`);
		assertSafePortablePath(home, relativePath);
		const current = lstatSync(path);
		if (current.dev !== stat.dev || current.ino !== stat.ino) {
			throw new Error(`Backup source changed while opening: ${relativePath}`);
		}
		const bytes = readFileSync(descriptor);
		assertSafePortablePath(home, relativePath);
		if (bytes.byteLength > MAX_FILE_BYTES)
			throw new Error(`Backup file is too large: ${relativePath}`);
		return { bytes, mode: stat.mode };
	} finally {
		closeSync(descriptor);
	}
}

function collectTree(
	source: string,
	relativeRoot: string,
	warnings: string[],
	filter: (relativePath: string) => boolean = () => true
): string[] {
	const root = join(source, relativeRoot);
	if (!existsSync(root)) return [];
	assertSafePortablePath(source, relativeRoot);
	if (!lstatSync(root).isDirectory()) {
		warnings.push(`Skipped non-directory backup root: ${relativeRoot}`);
		return [];
	}
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const item = relative(source, path).split(sep).join('/');
			if (!filter(relative(root, path))) continue;
			if (entry.name === 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink())) {
				warnings.push(
					`Skipped generated dependency tree: ${item}; reinstall dependencies after restore.`
				);
				continue;
			}
			if (entry.isSymbolicLink()) {
				warnings.push(`Skipped symlink: ${item}`);
				continue;
			}
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile()) {
				warnings.push(`Skipped non-regular file: ${item}`);
				continue;
			}
			files.push(path);
			if (files.length > MAX_FILES) throw new Error(`Backup exceeds ${MAX_FILES} files`);
		}
	}
	return files.sort();
}

function addIfFile(files: Set<string>, source: string, relativePath: string): void {
	const path = join(source, relativePath);
	if (!existsSync(path)) return;
	assertSafePortablePath(source, relativePath);
	if (lstatSync(path).isFile()) files.add(path);
}

export async function createBackup(options: BackupOptions): Promise<BackupManifest> {
	const source = sourceRoot(options.sourceHome);
	const stack = readStackConfig(source);
	if (!stack.ok) throw new Error(stack.error);
	const warnings: string[] = [];
	const files = new Set<string>();
	for (const path of collectTree(source, 'knowledge', warnings, (file) => {
		const parts = file.split(sep);
		return (
			!['secrets', 'env', '.git', '.akm'].includes(parts[0] ?? '') &&
			!(parts[0] === 'imported-config' && parts[1] === 'akm')
		);
	}))
		files.add(path);
	for (const path of collectTree(source, 'workspace', warnings)) files.add(path);
	if (existsSync(join(source, 'knowledge/imported-config/akm'))) {
		warnings.push(
			'Skipped historical knowledge/imported-config/akm; keep it in a private full-home backup, not searchable knowledge.'
		);
	}
	if (existsSync(join(source, 'knowledge/.akm'))) {
		warnings.push(
			'Skipped generated AKM metadata (knowledge/.akm); indexes and local runtime state are rebuilt after restore.'
		);
	}
	const nonPortableNativeConfiguration = hasNonPortableNativeConfiguration(source);
	for (const relativePath of [
		'config/assistant/opencode.json',
		'config/assistant/persona.md',
		'config/assistant/user-profile.md'
	])
		if (relativePath === 'config/assistant/opencode.json' && nonPortableNativeConfiguration) {
			warnings.push(
				'Native OpenCode configuration with settings beyond portable model/provider preferences was omitted; review and reintroduce custom configuration manually from a private full-home backup.'
			);
		} else if (
			relativePath === 'config/assistant/opencode.json' &&
			hasInlineProviderCredentials(source) &&
			!options.includeProviderAuth
		) {
			warnings.push(
				'Native OpenCode configuration containing inline provider credentials was omitted; use --include-provider-auth or sign in again after restore.'
			);
		} else addIfFile(files, source, relativePath);
	let providerFiles: string[] = [];
	try {
		providerFiles = nonPortableNativeConfiguration ? [] : providerSecretFiles(source);
	} catch (error) {
		if (options.includeProviderAuth) throw error;
		warnings.push(
			'Provider file references could not be safely backed up; configure the provider again or review references before opting in to --include-provider-auth.'
		);
	}
	if (options.includeProviderAuth) {
		addIfFile(files, source, 'knowledge/secrets/auth.json');
		if (files.has(join(source, 'knowledge/secrets/auth.json'))) {
			readProviderSecretFile(source, 'knowledge/secrets/auth.json');
		}
		for (const relativePath of providerFiles) {
			readProviderSecretFile(source, relativePath);
			files.add(join(source, relativePath));
		}
	} else if (providerFiles.length > 0) {
		warnings.push(
			'Provider key files were omitted; use --include-provider-auth or sign in again after restore.'
		);
	}
	if (options.includeUserEnv) addIfFile(files, source, 'knowledge/env/user.env');
	if (options.includePortalMaps) {
		for (const portal of ['discord', 'slack']) {
			addIfFile(files, source, `config/portal/${portal}/credentials.json`);
		}
	}
	if (options.includeOAuth) {
		for (const name of ['oauth.json', 'oauth-identities.json']) {
			addIfFile(files, source, `config/guardian/${name}`);
		}
	}

	if (files.size > MAX_FILES) throw new Error(`Backup exceeds ${MAX_FILES} files`);
	let inspectedBytes = 0;
	for (const file of files) {
		assertSafePortablePath(source, relative(source, file).split(sep).join('/'));
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
			throw new Error(`Backup source is not a bounded regular file: ${relative(source, file)}`);
		}
		inspectedBytes += stat.size;
		if (inspectedBytes > MAX_TOTAL_BYTES) throw new Error('Backup exceeds the 20 GiB safety limit');
	}
	const destination = prepareDestination(options.destination, source);
	let totalBytes = 0;
	const entries: BackupManifest['files'] = [];
	for (const file of [...files].sort()) {
		const relativePath = relative(source, file).split(sep).join('/');
		const isSecret =
			relativePath.startsWith('knowledge/secrets/') || relativePath === 'knowledge/env/user.env';
		const sourceFile = relativePath.startsWith('knowledge/secrets/')
			? { bytes: readProviderSecretFile(source, relativePath), mode: 0o600 }
			: readSourceFile(source, relativePath);
		totalBytes += sourceFile.bytes.byteLength;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Backup exceeds the 20 GiB safety limit');
		const target = join(destination, ...relativePath.split('/'));
		if (!contained(destination, target))
			throw new Error(`Backup path escaped destination: ${relativePath}`);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileAtomic(
			target,
			sourceFile.bytes,
			!isSecret && (sourceFile.mode & 0o111) !== 0 ? 0o700 : 0o600
		);
		const sha256 = createHash('sha256').update(sourceFile.bytes).digest('hex');
		entries.push({ path: relativePath, bytes: sourceFile.bytes.byteLength, sha256 });
	}

	const manifest: BackupManifest = {
		version: 1,
		scope: 'portable',
		excludedCategories: PORTABLE_BACKUP_EXCLUSIONS,
		preservation: inspectUnrestoredData(source, warnings),
		createdAt: new Date().toISOString(),
		sourceVersion: stack.config.version,
		stackConfig: stack.config,
		options: {
			providerAuth: options.includeProviderAuth === true,
			userEnv: options.includeUserEnv === true,
			portalMaps: options.includePortalMaps === true,
			oauth: options.includeOAuth === true
		},
		files: entries,
		warnings,
		totalBytes
	};
	writeFileAtomic(
		join(destination, 'openpalm-backup.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		0o600
	);
	return manifest;
}
