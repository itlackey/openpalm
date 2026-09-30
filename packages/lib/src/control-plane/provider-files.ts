import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync
} from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const MAX_PROVIDER_FILE_BYTES = 1024 * 1024;
const MAX_PROVIDER_FILES = 128;

function hasControlCharacters(value: string): boolean {
	return [...value].some(
		(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	);
}

/** Reject symlinks in every component, including dangling links, before portable file I/O. */
export function assertSafePortablePath(
	home: string,
	relativePath: string,
	allowMissing = false
): void {
	const parts = relativePath.split('/');
	if (
		isAbsolute(relativePath) ||
		relativePath.includes('\\') ||
		hasControlCharacters(relativePath) ||
		parts.some((part) => !part || part === '.' || part === '..')
	) {
		throw new Error('Portable file path is unsafe');
	}
	let current = home;
	for (const [index, part] of parts.entries()) {
		current = join(current, part);
		let stat: Stats;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw new Error(`Portable file is missing or unreadable: ${relativePath}`);
		}
		if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
			throw new Error(`Portable file path contains an unsafe component: ${relativePath}`);
		}
	}
	const resolved = relative(home, realpathSync(current));
	if (isAbsolute(resolved) || resolved === '..' || resolved.startsWith(`..${sep}`)) {
		throw new Error(`Portable file path escaped its home: ${relativePath}`);
	}
}

function readBoundedFile(home: string, relativePath: string): Buffer {
	assertSafePortablePath(home, relativePath);
	const descriptor = openSync(
		join(home, relativePath),
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
	);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > MAX_PROVIDER_FILE_BYTES) {
			throw new Error(
				'Provider configuration or secret must be a regular file no larger than 1 MiB'
			);
		}
		assertSafePortablePath(home, relativePath);
		const openedPath = lstatSync(join(home, relativePath));
		if (openedPath.dev !== stat.dev || openedPath.ino !== stat.ino) {
			throw new Error('Provider file changed while opening it');
		}
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		assertSafePortablePath(home, relativePath);
		const finalPath = lstatSync(join(home, relativePath));
		const finalFile = fstatSync(descriptor);
		if (
			length !== stat.size ||
			finalFile.size !== stat.size ||
			finalFile.mtimeMs !== stat.mtimeMs ||
			finalPath.dev !== stat.dev ||
			finalPath.ino !== stat.ino
		) {
			throw new Error('Provider file changed while reading it');
		}
		return bytes.subarray(0, length);
	} finally {
		closeSync(descriptor);
	}
}

function nativeConfiguration(home: string): Record<string, unknown> | null {
	const configPath = 'config/assistant/opencode.json';
	assertSafePortablePath(home, configPath, true);
	let bytes: Buffer;
	try {
		bytes = readBoundedFile(home, configPath);
	} catch (error) {
		try {
			lstatSync(join(home, configPath));
		} catch (missing) {
			if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null;
		}
		throw error;
	}
	let config: unknown;
	try {
		config = JSON.parse(bytes.toString('utf8')) as unknown;
	} catch {
		throw new Error(
			'Native OpenCode configuration must contain valid JSON; no configuration values were logged'
		);
	}
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		throw new Error('Native OpenCode configuration must contain a JSON object');
	}
	return config as Record<string, unknown>;
}

/** Portable configuration is provider/model intent, never plugin or MCP runtime/credential state. */
export function hasNonPortableNativeConfiguration(home: string): boolean {
	return Object.keys(nativeConfiguration(home) ?? {}).some(
		(key) => !['$schema', 'model', 'small_model', 'provider'].includes(key)
	);
}

/** Detect only recognized native provider credential fields; never rewrite arbitrary configuration. */
export function hasInlineProviderCredentials(home: string): boolean {
	const pending: unknown[] = [nativeConfiguration(home)?.provider];
	while (pending.length) {
		const value = pending.pop();
		if (!value || typeof value !== 'object') continue;
		for (const [key, item] of Object.entries(value)) {
			if (
				typeof item === 'string' &&
				/^(?:api[_-]?key|x-api-key|authorization|(?:access|auth)[_-]?token|token|secret|password)$/i.test(
					key
				) &&
				item.trim() &&
				!/^\{(?:env|file):[^{}]+\}$/.test(item)
			)
				return true;
			if (item && typeof item === 'object') pending.push(item);
		}
	}
	return false;
}

/** Only native provider references beneath the existing private /stash/secrets mount are portable. */
export function providerSecretFiles(home: string): string[] {
	const files = new Set<string>();
	const pending: unknown[] = [nativeConfiguration(home)?.provider];
	while (pending.length) {
		const value = pending.pop();
		if (typeof value === 'string' && value.includes('{file:')) {
			const match = /^\{file:\/stash\/secrets\/([^{}]+)\}$/.exec(value);
			if (!match?.[1])
				throw new Error('Provider file reference is not a portable /stash/secrets file');
			const path = `knowledge/secrets/${match[1]}`;
			// Validate spelling even when the caller has not opted in to reading secrets.
			const parts = path.split('/');
			if (
				path.includes('\\') ||
				hasControlCharacters(path) ||
				parts.some((part) => !part || part === '.' || part === '..')
			) {
				throw new Error('Provider file reference is not a safe private relative path');
			}
			files.add(path);
			if (files.size > MAX_PROVIDER_FILES)
				throw new Error('Provider configuration exceeds 128 private file references');
		} else if (value && typeof value === 'object') {
			pending.push(...Object.values(value));
		}
	}
	return [...files].sort();
}

export function readProviderSecretFile(home: string, relativePath: string): Buffer {
	if (!relativePath.startsWith('knowledge/secrets/'))
		throw new Error('Provider secret is outside its private directory');
	return readBoundedFile(home, relativePath);
}
