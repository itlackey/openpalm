import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readCredentialKey } from './credential-store.js';
import { writeFileAtomic } from './lean-foundation.js';
import { isCredentialUsername, type StackConfig } from './stack-config.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MAP_BYTES = 1_048_576;
const MAX_USER_MAPPINGS = 10_000;

export const PORTAL_CREDENTIAL_MAP_VERSION = 1 as const;
export const PORTAL_CREDENTIAL_BUNDLE_VERSION = 1 as const;
export const PORTAL_NAMES = ['discord', 'slack'] as const;

export type PortalName = (typeof PORTAL_NAMES)[number];
export type PortalCredentialMap = {
	version: typeof PORTAL_CREDENTIAL_MAP_VERSION;
	users: Record<string, string>;
};

export type PortalCredentialBundle = {
	version: typeof PORTAL_CREDENTIAL_BUNDLE_VERSION;
	default: string;
	users: Record<string, string>;
	credentials: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

export function isPortalName(value: unknown): value is PortalName {
	return typeof value === 'string' && PORTAL_NAMES.includes(value as PortalName);
}

export function isPortalUserId(portal: PortalName, value: unknown): value is string {
	if (typeof value !== 'string') return false;
	return portal === 'discord' ? /^[0-9]{5,32}$/.test(value) : /^[A-Z][A-Z0-9]{2,31}$/.test(value);
}

export function portalCredentialMapFile(homeDir: string, portal: PortalName): string {
	return join(homeDir, 'config', 'portal', portal, 'credentials.json');
}

export function portalCredentialBundleDir(homeDir: string, portal: PortalName): string {
	return join(homeDir, 'state', 'portal-credentials', portal);
}

export function portalCredentialBundleFile(homeDir: string, portal: PortalName): string {
	return join(portalCredentialBundleDir(homeDir, portal), 'credentials.json');
}

function emptyMap(): PortalCredentialMap {
	return { version: PORTAL_CREDENTIAL_MAP_VERSION, users: {} };
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (!lstatSync(path).isDirectory())
		throw new Error(`Refusing non-directory portal path: ${path}`);
	chmodSync(path, PRIVATE_DIR_MODE);
}

export function parsePortalCredentialMap(portal: PortalName, value: unknown): PortalCredentialMap {
	const root = asRecord(value);
	if (
		!root ||
		root.version !== PORTAL_CREDENTIAL_MAP_VERSION ||
		!hasOnlyKeys(root, ['version', 'users'])
	) {
		throw new Error(`${portal} credential map must use version ${PORTAL_CREDENTIAL_MAP_VERSION}`);
	}
	const users = asRecord(root.users);
	if (!users) throw new Error(`${portal} credential map users must be an object`);
	const entries = Object.entries(users);
	if (entries.length > MAX_USER_MAPPINGS) {
		throw new Error(`${portal} credential map exceeds ${MAX_USER_MAPPINGS} users`);
	}
	const parsed: Record<string, string> = {};
	for (const [userId, username] of entries.sort(([left], [right]) => left.localeCompare(right))) {
		if (!isPortalUserId(portal, userId)) {
			throw new Error(`Invalid ${portal} user ID: ${userId}`);
		}
		if (!isCredentialUsername(username)) {
			throw new Error(`${portal} user ${userId} has an invalid credential username`);
		}
		parsed[userId] = username;
	}
	return { version: PORTAL_CREDENTIAL_MAP_VERSION, users: parsed };
}

export function readPortalCredentialMap(homeDir: string, portal: PortalName): PortalCredentialMap {
	const path = portalCredentialMapFile(homeDir, portal);
	if (!existsSync(path)) return emptyMap();
	if (!lstatSync(path).isFile())
		throw new Error(`Refusing non-file portal credential map: ${path}`);
	if (statSync(path).size > MAX_MAP_BYTES) {
		throw new Error(`${portal} credential map exceeds ${MAX_MAP_BYTES} bytes`);
	}
	try {
		return parsePortalCredentialMap(portal, JSON.parse(readFileSync(path, 'utf8')) as unknown);
	} catch (error) {
		throw new Error(
			`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export function writePortalCredentialMap(
	homeDir: string,
	portal: PortalName,
	value: PortalCredentialMap
): PortalCredentialMap {
	const parsed = parsePortalCredentialMap(portal, value);
	const path = portalCredentialMapFile(homeDir, portal);
	ensurePrivateDirectory(join(homeDir, 'config', 'portal', portal));
	if (existsSync(path) && !lstatSync(path).isFile()) {
		throw new Error(`Refusing non-file portal credential map: ${path}`);
	}
	writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`, PRIVATE_FILE_MODE);
	return parsed;
}

export function ensurePortalCredentialMaps(homeDir: string): void {
	for (const portal of PORTAL_NAMES) {
		const path = portalCredentialMapFile(homeDir, portal);
		if (!existsSync(path)) writePortalCredentialMap(homeDir, portal, emptyMap());
		else readPortalCredentialMap(homeDir, portal);
		chmodSync(path, PRIVATE_FILE_MODE);
	}
}

export function portalCredentialUsages(
	homeDir: string,
	config: StackConfig,
	username: string
): string[] {
	const usages: string[] = [];
	for (const portal of PORTAL_NAMES) {
		if (config.portals[portal].credential === username) usages.push(`${portal} default`);
		for (const [userId, mappedUsername] of Object.entries(
			readPortalCredentialMap(homeDir, portal).users
		)) {
			if (mappedUsername === username) usages.push(`${portal} user ${userId}`);
		}
	}
	return usages;
}

export function buildPortalCredentialBundle(
	homeDir: string,
	config: StackConfig,
	portal: PortalName
): PortalCredentialBundle {
	const mapping = readPortalCredentialMap(homeDir, portal);
	const defaultUsername = config.portals[portal].credential;
	const usernames = new Set([defaultUsername, ...Object.values(mapping.users)]);
	const credentials: Record<string, string> = {};
	for (const username of [...usernames].sort()) {
		if (!Object.hasOwn(config.credentials, username)) {
			throw new Error(`${portal} credential map references unknown credential: ${username}`);
		}
		credentials[username] = readCredentialKey(homeDir, username);
	}
	return {
		version: PORTAL_CREDENTIAL_BUNDLE_VERSION,
		default: defaultUsername,
		users: mapping.users,
		credentials
	};
}

export function syncPortalCredentialBundles(homeDir: string, config: StackConfig): void {
	ensurePortalCredentialMaps(homeDir);
	for (const portal of PORTAL_NAMES) {
		const directory = portalCredentialBundleDir(homeDir, portal);
		ensurePrivateDirectory(directory);
		const path = portalCredentialBundleFile(homeDir, portal);
		if (existsSync(path) && !lstatSync(path).isFile()) {
			throw new Error(`Refusing non-file portal credential bundle: ${path}`);
		}
		const bundle = buildPortalCredentialBundle(homeDir, config, portal);
		writeFileAtomic(path, `${JSON.stringify(bundle, null, 2)}\n`, PRIVATE_FILE_MODE);
	}
}
