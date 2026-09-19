import { lstatSync, readFileSync, statSync } from 'node:fs';

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import {
	bearerToken,
	findCredentialByUsername,
	type AuthenticatedCredential
} from './credentials.js';

const MAX_FILE_BYTES = 1_048_576;
const MAX_IDENTITIES = 10_000;
const VALUE_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;

type OAuthAlgorithm = (typeof ALGORITHMS)[number];
export type GuardianOAuthConfig = {
	version: 1;
	enabled: true;
	resource: string;
	issuer: string;
	jwksUrl: string;
	audience: string;
	scopes: string[];
	algorithms: OAuthAlgorithm[];
};
export type GuardianOAuthIdentityMap = {
	version: 1;
	identities: Array<{ issuer: string; subject: string; username: string }>;
};
export type OAuthClaims = { issuer: string; subject: string; scopes: ReadonlySet<string> };
export type GuardianOAuth = {
	config: GuardianOAuthConfig;
	authenticate: (request: Request) => Promise<AuthenticatedCredential | null>;
	challenge: string;
	metadata: Readonly<Record<string, unknown>>;
	metadataPaths: ReadonlySet<string>;
};

type CreateGuardianOAuthOptions = {
	configFile?: string;
	identityMapFile?: string;
	authDirectory?: string;
	verify?: (token: string, config: GuardianOAuthConfig) => Promise<OAuthClaims>;
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
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${label} must be an HTTPS URL`);
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
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
		if (typeof entry !== 'string' || !VALUE_RE.test(entry) || result.includes(entry)) {
			throw new Error(`${label} contains an invalid or duplicate value`);
		}
		result.push(entry);
	}
	return result;
}

function readJson(path: string): unknown {
	const stat = lstatSync(path);
	if (!stat.isFile() || statSync(path).size > MAX_FILE_BYTES) {
		throw new Error(`OAuth file is invalid: ${path}`);
	}
	return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function parseGuardianOAuthConfig(value: unknown): GuardianOAuthConfig | null {
	const root = asRecord(value);
	if (root?.version !== 1 || typeof root.enabled !== 'boolean') {
		throw new Error('OAuth config must use version 1');
	}
	if (!root.enabled) {
		if (!exactKeys(root, ['version', 'enabled'])) {
			throw new Error('Disabled OAuth config contains unsupported settings');
		}
		return null;
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
	if (!algorithms.every((algorithm) => ALGORITHMS.includes(algorithm as OAuthAlgorithm))) {
		throw new Error(`OAuth algorithms must be one of: ${ALGORITHMS.join(', ')}`);
	}
	return {
		version: 1,
		enabled: true,
		resource,
		issuer,
		jwksUrl,
		audience: root.audience,
		scopes,
		algorithms: algorithms as OAuthAlgorithm[]
	};
}

export function parseGuardianOAuthIdentityMap(value: unknown): GuardianOAuthIdentityMap {
	const root = asRecord(value);
	if (
		root?.version !== 1 ||
		!exactKeys(root, ['version', 'identities']) ||
		!Array.isArray(root.identities) ||
		root.identities.length > MAX_IDENTITIES
	) {
		throw new Error('OAuth identity map must use version 1');
	}
	const seen = new Set<string>();
	const identities: GuardianOAuthIdentityMap['identities'] = [];
	for (const raw of root.identities) {
		const item = asRecord(raw);
		if (!item || !exactKeys(item, ['issuer', 'subject', 'username'])) {
			throw new Error('OAuth identity map contains an invalid record');
		}
		const issuer = httpsUrl('OAuth identity issuer', item.issuer);
		if (
			!boundedIdentifier(item.subject) ||
			typeof item.username !== 'string' ||
			!/^[a-z][a-z0-9._-]{0,63}$/.test(item.username)
		) {
			throw new Error('OAuth identity map contains an invalid identity');
		}
		const key = `${issuer}\u0000${item.subject}`;
		if (seen.has(key)) throw new Error('OAuth identity map contains a duplicate identity');
		seen.add(key);
		identities.push({ issuer, subject: item.subject, username: item.username });
	}
	return { version: 1, identities };
}

export function loadGuardianOAuthConfig(path: string | undefined): GuardianOAuthConfig | null {
	return path ? parseGuardianOAuthConfig(readJson(path)) : null;
}

function tokenScopes(payload: JWTPayload): ReadonlySet<string> {
	const result = new Set<string>();
	if (typeof payload.scope === 'string') {
		for (const scope of payload.scope.split(/\s+/u)) if (scope) result.add(scope);
	}
	const scp = payload.scp;
	if (typeof scp === 'string') {
		for (const scope of scp.split(/\s+/u)) if (scope) result.add(scope);
	} else if (Array.isArray(scp)) {
		for (const scope of scp) if (typeof scope === 'string') result.add(scope);
	}
	return result;
}

function createTokenVerifier(
	config: GuardianOAuthConfig
): (token: string, config: GuardianOAuthConfig) => Promise<OAuthClaims> {
	const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5_000 });
	return async (token, current) => {
		const verified = await jwtVerify(token, jwks, {
			issuer: current.issuer,
			audience: current.audience,
			algorithms: current.algorithms
		});
		if (!verified.payload.iss || !verified.payload.sub) {
			throw new Error('JWT identity is incomplete');
		}
		return {
			issuer: verified.payload.iss,
			subject: verified.payload.sub,
			scopes: tokenScopes(verified.payload)
		};
	};
}

export function createGuardianOAuth(
	options: CreateGuardianOAuthOptions = {}
): GuardianOAuth | null {
	const configFile = options.configFile ?? Bun.env.GUARDIAN_OAUTH_CONFIG_FILE;
	const identityMapFile =
		options.identityMapFile ?? Bun.env.GUARDIAN_OAUTH_IDENTITIES_FILE;
	const authDirectory = options.authDirectory ?? Bun.env.GUARDIAN_AUTH_DIR ?? '';
	const config = loadGuardianOAuthConfig(configFile);
	if (!config) return null;
	if (!identityMapFile) throw new Error('Guardian OAuth identity map is not configured');
	parseGuardianOAuthIdentityMap(readJson(identityMapFile));
	const metadataUrl = new URL('/.well-known/oauth-protected-resource', config.resource).href;
	const resourcePath = new URL(config.resource).pathname.replace(/^\//u, '');
	const metadataPaths = new Set([
		'/.well-known/oauth-protected-resource',
		`/.well-known/oauth-protected-resource/${resourcePath}`
	]);
	const verify = options.verify ?? createTokenVerifier(config);
	return {
		config,
		metadataPaths,
		metadata: Object.freeze({
			resource: config.resource,
			authorization_servers: [config.issuer],
			scopes_supported: config.scopes,
			bearer_methods_supported: ['header'],
			resource_name: 'OpenPalm Guardian MCP'
		}),
		challenge: `Bearer resource_metadata="${metadataUrl}", scope="${config.scopes.join(' ')}"`,
		async authenticate(request) {
			const token = bearerToken(request);
			if (!token) return null;
			try {
				const claims = await verify(token, config);
				if (
					claims.issuer !== config.issuer ||
					config.scopes.some((scope) => !claims.scopes.has(scope))
				) {
					return null;
				}
				const identityMap = parseGuardianOAuthIdentityMap(readJson(identityMapFile));
				const match = identityMap.identities.find(
					(identity) =>
						identity.issuer === claims.issuer && identity.subject === claims.subject
				);
				return match
					? findCredentialByUsername(match.username, authDirectory)
					: null;
			} catch {
				return null;
			}
		}
	};
}
