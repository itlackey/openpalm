import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './lean-foundation.js';
import { isCredentialUsername } from './stack-config.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_FILE_BYTES = 1_048_576;
const MAX_IDENTITIES = 10_000;
const SCOPE_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

export const OAUTH_CONFIG_VERSION = 1 as const;
export const OAUTH_IDENTITY_MAP_VERSION = 1 as const;
export const OAUTH_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;

export type OAuthAlgorithm = (typeof OAUTH_ALGORITHMS)[number];
export type OAuthConfig =
	| { version: typeof OAUTH_CONFIG_VERSION; enabled: false }
	| {
			version: typeof OAUTH_CONFIG_VERSION;
			enabled: true;
			resource: string;
			issuer: string;
			jwksUrl: string;
			audience: string;
			scopes: string[];
			algorithms: OAuthAlgorithm[];
	  };
export type OAuthIdentity = { issuer: string; subject: string; username: string };
export type OAuthIdentityMap = {
	version: typeof OAUTH_IDENTITY_MAP_VERSION;
	identities: OAuthIdentity[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function boundedIdentifier(value: unknown): value is string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 512) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || codePoint === 0x7f) return false;
	}
	return true;
}

function httpsUrl(label: string, value: unknown): string {
	if (typeof value !== 'string' || value.length > 2_048) {
		throw new Error(`${label} must be an HTTPS URL`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an HTTPS URL`);
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
		throw new Error(`${label} must be an HTTPS URL without credentials, query, or fragment`);
	}
	return value;
}

function stringList(label: string, value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
		throw new Error(`${label} must contain between 1 and 16 entries`);
	}
	const result: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string' || !SCOPE_RE.test(entry)) {
			throw new Error(`${label} contains an invalid value`);
		}
		if (result.includes(entry)) throw new Error(`${label} contains a duplicate value`);
		result.push(entry);
	}
	return result;
}

export function oauthConfigFile(homeDir: string): string {
	return join(homeDir, 'config', 'guardian', 'oauth.json');
}

export function oauthIdentityMapFile(homeDir: string): string {
	return join(homeDir, 'config', 'guardian', 'oauth-identities.json');
}

export function defaultOAuthConfig(): OAuthConfig {
	return { version: OAUTH_CONFIG_VERSION, enabled: false };
}

export function defaultOAuthIdentityMap(): OAuthIdentityMap {
	return { version: OAUTH_IDENTITY_MAP_VERSION, identities: [] };
}

export function parseOAuthConfig(value: unknown): OAuthConfig {
	const root = asRecord(value);
	if (!root || root.version !== OAUTH_CONFIG_VERSION || typeof root.enabled !== 'boolean') {
		throw new Error(`OAuth config must use version ${OAUTH_CONFIG_VERSION}`);
	}
	if (!root.enabled) {
		if (!exactKeys(root, ['version', 'enabled'])) {
			throw new Error('Disabled OAuth config contains unsupported settings');
		}
		return defaultOAuthConfig();
	}
	if (
		!exactKeys(root, [
			'version',
			'enabled',
			'resource',
			'issuer',
			'jwksUrl',
			'audience',
			'scopes',
			'algorithms'
		])
	) {
		throw new Error('Enabled OAuth config contains unsupported settings');
	}
	const resource = httpsUrl('OAuth resource', root.resource);
	if (new URL(resource).pathname === '/') throw new Error('OAuth resource must identify the MCP path');
	const issuer = httpsUrl('OAuth issuer', root.issuer);
	const jwksUrl = httpsUrl('OAuth JWKS URL', root.jwksUrl);
	if (!boundedIdentifier(root.audience)) {
		throw new Error('OAuth audience must be a non-empty identifier');
	}
	const scopes = stringList('OAuth scopes', root.scopes);
	const algorithms = stringList('OAuth algorithms', root.algorithms);
	if (!algorithms.every((algorithm) => OAUTH_ALGORITHMS.includes(algorithm as OAuthAlgorithm))) {
		throw new Error(`OAuth algorithms must be one of: ${OAUTH_ALGORITHMS.join(', ')}`);
	}
	return {
		version: OAUTH_CONFIG_VERSION,
		enabled: true,
		resource,
		issuer,
		jwksUrl,
		audience: root.audience,
		scopes,
		algorithms: algorithms as OAuthAlgorithm[]
	};
}

export function parseOAuthIdentityMap(value: unknown): OAuthIdentityMap {
	const root = asRecord(value);
	if (
		!root ||
		root.version !== OAUTH_IDENTITY_MAP_VERSION ||
		!exactKeys(root, ['version', 'identities']) ||
		!Array.isArray(root.identities) ||
		root.identities.length > MAX_IDENTITIES
	) {
		throw new Error(`OAuth identity map must use version ${OAUTH_IDENTITY_MAP_VERSION}`);
	}
	const seen = new Set<string>();
	const identities: OAuthIdentity[] = [];
	for (const raw of root.identities) {
		const item = asRecord(raw);
		if (!item || !exactKeys(item, ['issuer', 'subject', 'username'])) {
			throw new Error('OAuth identity map contains an invalid record');
		}
		const issuer = httpsUrl('OAuth identity issuer', item.issuer);
		if (!boundedIdentifier(item.subject)) {
			throw new Error('OAuth identity subject is invalid');
		}
		if (!isCredentialUsername(item.username)) {
			throw new Error('OAuth identity credential username is invalid');
		}
		const identityKey = `${issuer}\u0000${item.subject}`;
		if (seen.has(identityKey)) throw new Error('OAuth identity map contains a duplicate identity');
		seen.add(identityKey);
		identities.push({ issuer, subject: item.subject, username: item.username });
	}
	identities.sort(
		(left, right) =>
			left.issuer.localeCompare(right.issuer) || left.subject.localeCompare(right.subject)
	);
	return { version: OAUTH_IDENTITY_MAP_VERSION, identities };
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (!lstatSync(path).isDirectory()) throw new Error(`Refusing non-directory OAuth path: ${path}`);
	chmodSync(path, PRIVATE_DIR_MODE);
}

function readJson(path: string): unknown {
	if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`OAuth file is missing: ${path}`);
	if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`OAuth file exceeds ${MAX_FILE_BYTES} bytes`);
	return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJson(path: string, value: unknown): void {
	ensurePrivateDirectory(dirname(path));
	if (existsSync(path) && !lstatSync(path).isFile()) {
		throw new Error(`Refusing non-file OAuth path: ${path}`);
	}
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, PRIVATE_FILE_MODE);
}

export function readOAuthConfig(homeDir: string): OAuthConfig {
	return parseOAuthConfig(readJson(oauthConfigFile(homeDir)));
}

export function writeOAuthConfig(homeDir: string, value: OAuthConfig): OAuthConfig {
	const parsed = parseOAuthConfig(value);
	writeJson(oauthConfigFile(homeDir), parsed);
	return parsed;
}

export function readOAuthIdentityMap(homeDir: string): OAuthIdentityMap {
	return parseOAuthIdentityMap(readJson(oauthIdentityMapFile(homeDir)));
}

export function writeOAuthIdentityMap(
	homeDir: string,
	value: OAuthIdentityMap
): OAuthIdentityMap {
	const parsed = parseOAuthIdentityMap(value);
	writeJson(oauthIdentityMapFile(homeDir), parsed);
	return parsed;
}

export function ensureOAuthFiles(homeDir: string): void {
	const configPath = oauthConfigFile(homeDir);
	if (!existsSync(configPath)) writeOAuthConfig(homeDir, defaultOAuthConfig());
	else readOAuthConfig(homeDir);
	const identitiesPath = oauthIdentityMapFile(homeDir);
	if (!existsSync(identitiesPath)) writeOAuthIdentityMap(homeDir, defaultOAuthIdentityMap());
	else readOAuthIdentityMap(homeDir);
	chmodSync(configPath, PRIVATE_FILE_MODE);
	chmodSync(identitiesPath, PRIVATE_FILE_MODE);
}

export function oauthCredentialUsages(homeDir: string, username: string): string[] {
	return readOAuthIdentityMap(homeDir).identities
		.filter((identity) => identity.username === username)
		.map((identity) => `oauth ${identity.issuer} subject ${identity.subject}`);
}
