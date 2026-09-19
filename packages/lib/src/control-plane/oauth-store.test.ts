import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	defaultOAuthConfig,
	ensureOAuthFiles,
	oauthConfigFile,
	oauthCredentialUsages,
	oauthIdentityMapFile,
	parseOAuthConfig,
	parseOAuthIdentityMap,
	readOAuthConfig,
	readOAuthIdentityMap,
	writeOAuthConfig,
	writeOAuthIdentityMap
} from './oauth-store.js';

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-oauth-store-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OAuth operator configuration', () => {
	it('seeds disabled private files and restores their modes', () => {
		const root = temporaryRoot();
		ensureOAuthFiles(root);
		expect(readOAuthConfig(root)).toEqual(defaultOAuthConfig());
		expect(readOAuthIdentityMap(root).identities).toEqual([]);
		if (process.platform !== 'win32') {
			expect(statSync(oauthConfigFile(root)).mode & 0o077).toBe(0);
			expect(statSync(oauthIdentityMapFile(root)).mode & 0o077).toBe(0);
			chmodSync(oauthConfigFile(root), 0o644);
			ensureOAuthFiles(root);
			expect(statSync(oauthConfigFile(root)).mode & 0o077).toBe(0);
		}
	});

	it('accepts a strict HTTPS resource-server configuration', () => {
		const root = temporaryRoot();
		ensureOAuthFiles(root);
		const value = writeOAuthConfig(root, {
			version: 1,
			enabled: true,
			resource: 'https://agent.example.com/mcp',
			issuer: 'https://id.example.com/',
			jwksUrl: 'https://id.example.com/.well-known/jwks.json',
			audience: 'https://agent.example.com/mcp',
			scopes: ['openpalm'],
			algorithms: ['RS256']
		});
		expect(readOAuthConfig(root)).toEqual(value);
		expect(() =>
			parseOAuthConfig({ ...value, resource: 'http://agent.example.com/mcp' })
		).toThrow('HTTPS');
		expect(() => parseOAuthConfig({ ...value, extra: true })).toThrow('unsupported');
	});

	it('maps exact issuer and subject pairs to named credentials', () => {
		const root = temporaryRoot();
		ensureOAuthFiles(root);
		writeOAuthIdentityMap(root, {
			version: 1,
			identities: [
				{ issuer: 'https://id.example.com/', subject: 'user-2', username: 'read-user' },
				{ issuer: 'https://id.example.com/', subject: 'user-1', username: 'owner' }
			]
		});
		expect(readOAuthIdentityMap(root).identities.map((entry) => entry.subject)).toEqual([
			'user-1',
			'user-2'
		]);
		expect(oauthCredentialUsages(root, 'read-user')).toEqual([
			'oauth https://id.example.com/ subject user-2'
		]);
		expect(() =>
			parseOAuthIdentityMap({
				version: 1,
				identities: [
					{ issuer: 'https://id.example.com/', subject: 'same', username: 'owner' },
					{ issuer: 'https://id.example.com/', subject: 'same', username: 'read-user' }
				]
			})
		).toThrow('duplicate');
	});
});
