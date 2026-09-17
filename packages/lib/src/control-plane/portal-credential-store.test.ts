import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCredentialKeys, writeCredentialKey } from './credential-store.js';
import {
	buildPortalCredentialBundle,
	parsePortalCredentialMap,
	portalCredentialBundleFile,
	portalCredentialUsages,
	readPortalCredentialMap,
	syncPortalCredentialBundles,
	writePortalCredentialMap
} from './portal-credential-store.js';
import { createCredentialId, defaultStackConfig } from './stack-config.js';

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-portal-credentials-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portal credential maps', () => {
	it('validates platform user IDs and credential usernames', () => {
		expect(
			parsePortalCredentialMap('discord', {
				version: 1,
				users: { '1234567890': 'support-read' }
			})
		).toEqual({ version: 1, users: { '1234567890': 'support-read' } });
		expect(() =>
			parsePortalCredentialMap('discord', { version: 1, users: { alice: 'owner' } })
		).toThrow('Invalid discord user ID');
		expect(() =>
			parsePortalCredentialMap('slack', { version: 1, users: { U123ABC: 'UPPER' } })
		).toThrow('invalid credential username');
	});

	it('builds a portal-only keyring from the default and mapped credentials', () => {
		const root = temporaryRoot();
		const config = defaultStackConfig();
		config.credentials['support-read'] = { id: createCredentialId(), policy: 'read' };
		ensureCredentialKeys(root, config);
		writeCredentialKey(root, 'owner', 'o'.repeat(32));
		writeCredentialKey(root, 'discord', 'd'.repeat(32));
		writeCredentialKey(root, 'slack', 's'.repeat(32));
		writeCredentialKey(root, 'support-read', 'r'.repeat(32));
		writePortalCredentialMap(root, 'discord', {
			version: 1,
			users: { '1234567890': 'support-read' }
		});

		const bundle = buildPortalCredentialBundle(root, config, 'discord');
		expect(bundle).toEqual({
			version: 1,
			default: 'discord',
			users: { '1234567890': 'support-read' },
			credentials: { discord: 'd'.repeat(32), 'support-read': 'r'.repeat(32) }
		});
		expect(bundle.credentials).not.toHaveProperty('owner');
		expect(portalCredentialUsages(root, config, 'support-read')).toEqual([
			'discord user 1234567890'
		]);
	});

	it('writes private runtime bundles and rejects stale credential references', () => {
		const root = temporaryRoot();
		const config = defaultStackConfig();
		ensureCredentialKeys(root, config);
		writePortalCredentialMap(root, 'slack', { version: 1, users: { U123ABC: 'owner' } });
		syncPortalCredentialBundles(root, config);
		const path = portalCredentialBundleFile(root, 'slack');
		expect(JSON.parse(readFileSync(path, 'utf8')).users).toEqual({ U123ABC: 'owner' });
		if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);

		const mapping = readPortalCredentialMap(root, 'slack');
		mapping.users.U999XYZ = 'missing';
		writePortalCredentialMap(root, 'slack', mapping);
		expect(() => syncPortalCredentialBundles(root, config)).toThrow('unknown credential: missing');
	});

	it('restores private mode on an existing mapping file', () => {
		if (process.platform === 'win32') return;
		const root = temporaryRoot();
		writePortalCredentialMap(root, 'discord', { version: 1, users: {} });
		const path = join(root, 'config', 'portal', 'discord', 'credentials.json');
		chmodSync(path, 0o644);
		const config = defaultStackConfig();
		ensureCredentialKeys(root, config);
		syncPortalCredentialBundles(root, config);
		expect(statSync(path).mode & 0o077).toBe(0);
	});
});
