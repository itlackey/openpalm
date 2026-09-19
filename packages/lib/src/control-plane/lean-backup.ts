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
import { writeFileAtomic } from './lean-foundation.js';

const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

export type LeanBackupOptions = {
	sourceHome: string;
	destination: string;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};

export type LeanBackupManifest = {
	version: 1;
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

function readSourceFile(path: string): { bytes: Buffer; mode: number } {
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new Error(`Backup source is not a regular file: ${path}`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Backup file is too large: ${path}`);
		return { bytes: readFileSync(descriptor), mode: stat.mode };
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
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const item = relative(source, path).split(sep).join('/');
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
			if (filter(relative(root, path))) files.push(path);
			if (files.length > MAX_FILES) throw new Error(`Backup exceeds ${MAX_FILES} files`);
		}
	}
	return files.sort();
}

function addIfFile(files: Set<string>, path: string): void {
	if (existsSync(path) && lstatSync(path).isFile()) files.add(path);
}

export async function createLeanBackup(options: LeanBackupOptions): Promise<LeanBackupManifest> {
	const source = sourceRoot(options.sourceHome);
	const stack = readStackConfig(source);
	if (!stack.ok) throw new Error(stack.error);
	const destination = prepareDestination(options.destination, source);
	const warnings: string[] = [];
	const files = new Set<string>();
	for (const path of collectTree(source, 'knowledge', warnings, (file) => {
		const first = file.split(sep)[0];
		return !['secrets', 'env', '.git', 'node_modules'].includes(first ?? '');
	}))
		files.add(path);
	for (const path of collectTree(source, 'workspace', warnings)) files.add(path);
	for (const path of collectTree(source, 'config/akm', warnings)) files.add(path);
	for (const relativePath of [
		'config/assistant/opencode.json',
		'config/assistant/persona.md',
		'config/assistant/user-profile.md'
	])
		addIfFile(files, join(source, relativePath));
	if (options.includeProviderAuth) addIfFile(files, join(source, 'knowledge/secrets/auth.json'));
	if (options.includeUserEnv) addIfFile(files, join(source, 'knowledge/env/user.env'));
	if (options.includePortalMaps) {
		for (const portal of ['discord', 'slack']) {
			addIfFile(files, join(source, 'config', 'portal', portal, 'credentials.json'));
		}
	}
	if (options.includeOAuth) {
		for (const name of ['oauth.json', 'oauth-identities.json']) {
			addIfFile(files, join(source, 'config', 'guardian', name));
		}
	}

	let totalBytes = 0;
	const entries: LeanBackupManifest['files'] = [];
	for (const file of [...files].sort()) {
		const sourceFile = readSourceFile(file);
		totalBytes += sourceFile.bytes.byteLength;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Backup exceeds the 20 GiB safety limit');
		const relativePath = relative(source, file).split(sep).join('/');
		const target = join(destination, ...relativePath.split('/'));
		if (!contained(destination, target))
			throw new Error(`Backup path escaped destination: ${relativePath}`);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileAtomic(target, sourceFile.bytes, (sourceFile.mode & 0o111) !== 0 ? 0o700 : 0o600);
		const sha256 = createHash('sha256').update(sourceFile.bytes).digest('hex');
		entries.push({ path: relativePath, bytes: sourceFile.bytes.byteLength, sha256 });
	}

	const manifest: LeanBackupManifest = {
		version: 1,
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
