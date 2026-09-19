import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
	createGuardianOAuth,
	createOAuthTokenVerifier,
	parseGuardianOAuthConfig,
	parseGuardianOAuthIdentityMap
} from './oauth.js';

const directories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), 'openpalm-oauth-'));
	directories.push(path);
	return path;
}

function fixture() {
	const root = temporaryDirectory();
	const authDirectory = join(root, 'credentials');
	mkdirSync(join(authDirectory, 'alice'), { recursive: true });
	writeFileSync(join(authDirectory, 'alice', 'key'), `${'a'.repeat(32)}\n`);
	writeFileSync(
		join(authDirectory, 'registry.json'),
		JSON.stringify({
			version: 1,
			credentials: [{ username: 'alice', id: `cred_${'b'.repeat(32)}`, policy: 'read' }]
		})
	);
	const configFile = join(root, 'oauth.json');
	const identityMapFile = join(root, 'oauth-identities.json');
	writeFileSync(
		configFile,
		JSON.stringify({
			version: 1,
			enabled: true,
			resource: 'https://agent.example/mcp',
			issuer: 'https://identity.example/',
			jwksUrl: 'https://identity.example/jwks.json',
			audience: 'https://agent.example/mcp',
			scopes: ['openpalm'],
			algorithms: ['RS256']
		})
	);
	writeFileSync(
		identityMapFile,
		JSON.stringify({
			version: 1,
			identities: [{ issuer: 'https://identity.example/', subject: 'user-42', username: 'alice' }]
		})
	);
	return { authDirectory, configFile, identityMapFile };
}

afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Guardian OAuth resource server', () => {
	it('strictly validates disabled config and identity mappings', () => {
		expect(parseGuardianOAuthConfig({ version: 1, enabled: false })).toBeNull();
		expect(() =>
			parseGuardianOAuthConfig({ version: 1, enabled: false, issuer: 'ignored' })
		).toThrow('unsupported');
		expect(() =>
			parseGuardianOAuthIdentityMap({
				version: 1,
				identities: [{ issuer: 'http://identity.example', subject: 'user', username: 'alice' }]
			})
		).toThrow('HTTPS');
	});

	it('maps a verified issuer and subject to the named credential policy', async () => {
		const files = fixture();
		const oauth = createGuardianOAuth({
			...files,
			verify: async () => ({
				issuer: 'https://identity.example/',
				subject: 'user-42',
				scopes: new Set(['openpalm'])
			})
		});
		expect(oauth).not.toBeNull();
		expect(
			await oauth?.authenticate(
				new Request('https://agent.example/mcp', {
					headers: { authorization: 'Bearer signed-jwt' }
				})
			)
		).toEqual({ username: 'alice', id: `cred_${'b'.repeat(32)}`, policy: 'read' });
		expect(oauth?.metadata).toMatchObject({
			resource: 'https://agent.example/mcp',
			authorization_servers: ['https://identity.example/']
		});
	});

	it('fails closed for missing scopes and unmapped identities', async () => {
		const files = fixture();
		const missingScope = createGuardianOAuth({
			...files,
			verify: async () => ({
				issuer: 'https://identity.example/',
				subject: 'user-42',
				scopes: new Set()
			})
		});
		const unknownIdentity = createGuardianOAuth({
			...files,
			verify: async () => ({
				issuer: 'https://identity.example/',
				subject: 'unknown',
				scopes: new Set(['openpalm'])
			})
		});
		const request = new Request('https://agent.example/mcp', {
			headers: { authorization: 'Bearer signed-jwt' }
		});
		expect(await missingScope?.authenticate(request)).toBeNull();
		expect(await unknownIdentity?.authenticate(request)).toBeNull();
	});

	it('verifies signed JWTs, expiry, audience, scope, key rotation, and live mapping changes', async () => {
		const files = fixture();
		const config = parseGuardianOAuthConfig(
			JSON.parse(readFileSync(files.configFile, 'utf8')) as unknown
		);
		if (!config) throw new Error('OAuth fixture is disabled');
		const first = await generateKeyPair('RS256');
		const second = await generateKeyPair('RS256');
		const firstJwk = { ...(await exportJWK(first.publicKey)), kid: 'first', alg: 'RS256' };
		const secondJwk = { ...(await exportJWK(second.publicKey)), kid: 'second', alg: 'RS256' };
		const make = async (
			key: CryptoKey,
			kid: string,
			overrides: { audience?: string; subject?: string; scope?: string; expired?: boolean } = {}
		) =>
			new SignJWT({ scope: overrides.scope ?? 'openpalm' })
				.setProtectedHeader({ alg: 'RS256', kid })
				.setIssuer(config.issuer)
				.setSubject(overrides.subject ?? 'user-42')
				.setAudience(overrides.audience ?? config.audience)
				.setIssuedAt()
				.setExpirationTime(overrides.expired ? '1 second ago' : '5 minutes')
				.sign(key);
		const oauthWith = (keySet: ReturnType<typeof createLocalJWKSet>) =>
			createGuardianOAuth({
				...files,
				verify: createOAuthTokenVerifier(config, keySet)
			});
		const authenticate = (oauth: ReturnType<typeof createGuardianOAuth>, token: string) =>
			oauth?.authenticate(
				new Request('https://agent.example/mcp', {
					headers: { authorization: `Bearer ${token}` }
				})
			);

		const firstOAuth = oauthWith(createLocalJWKSet({ keys: [firstJwk] }));
		const valid = await make(first.privateKey, 'first');
		expect(await authenticate(firstOAuth, valid)).toMatchObject({
			username: 'alice',
			policy: 'read'
		});
		expect(
			await authenticate(
				firstOAuth,
				await make(first.privateKey, 'first', { audience: 'https://wrong.example/mcp' })
			)
		).toBeNull();
		expect(
			await authenticate(firstOAuth, await make(first.privateKey, 'first', { expired: true }))
		).toBeNull();
		expect(
			await authenticate(firstOAuth, await make(first.privateKey, 'first', { scope: 'profile' }))
		).toBeNull();

		const rotatedOAuth = oauthWith(createLocalJWKSet({ keys: [secondJwk] }));
		expect(await authenticate(rotatedOAuth, valid)).toBeNull();
		expect(await authenticate(rotatedOAuth, await make(second.privateKey, 'second'))).toMatchObject(
			{ username: 'alice' }
		);

		writeFileSync(
			files.identityMapFile,
			JSON.stringify({
				version: 1,
				identities: [{ issuer: config.issuer, subject: 'replacement-user', username: 'alice' }]
			})
		);
		expect(await authenticate(rotatedOAuth, await make(second.privateKey, 'second'))).toBeNull();
		expect(
			await authenticate(
				rotatedOAuth,
				await make(second.privateKey, 'second', { subject: 'replacement-user' })
			)
		).toMatchObject({ username: 'alice' });
	});
});
