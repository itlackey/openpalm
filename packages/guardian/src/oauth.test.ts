import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createGuardianOAuth,
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
			credentials: [
				{ username: 'alice', id: `cred_${'b'.repeat(32)}`, policy: 'read' }
			]
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
			identities: [
				{ issuer: 'https://identity.example/', subject: 'user-42', username: 'alice' }
			]
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
				identities: [
					{ issuer: 'http://identity.example', subject: 'user', username: 'alice' }
				]
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
});
