import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	PortalCredentialRegistry,
	credentialConversationKey,
	parseCredentialBundle
} from './credential-registry.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundleFile(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-portal-registry-'));
	roots.push(root);
	const path = join(root, 'credentials.json');
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			default: 'discord',
			users: { '1234567890': 'support-read' },
			credentials: {
				discord: 'd'.repeat(32),
				'support-read': 'r'.repeat(32)
			}
		})
	);
	return path;
}

describe('portal credential registry', () => {
	it('uses a mapped credential and falls back to the portal default', () => {
		const registry = new PortalCredentialRegistry('discord', bundleFile());
		expect(registry.forUser('1234567890')).toEqual({
			username: 'support-read',
			key: 'r'.repeat(32)
		});
		expect(registry.forUser('9876543210')).toEqual({
			username: 'discord',
			key: 'd'.repeat(32)
		});
	});

	it('rereads the bundle so key rotation applies without a portal restart', () => {
		const path = bundleFile();
		const registry = new PortalCredentialRegistry('discord', path);
		expect(registry.forUser('1234567890').key).toBe('r'.repeat(32));
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				default: 'discord',
				users: { '1234567890': 'support-read' },
				credentials: { discord: 'd'.repeat(32), 'support-read': 'n'.repeat(32) }
			})
		);
		expect(registry.forUser('1234567890').key).toBe('n'.repeat(32));
	});

	it('rejects unknown mappings and scopes conversation handles by credential', () => {
		expect(() =>
			parseCredentialBundle('slack', {
				version: 1,
				default: 'slack',
				users: { U123ABC: 'missing' },
				credentials: { slack: 's'.repeat(32) }
			})
		).toThrow('unavailable credential');
		expect(credentialConversationKey('owner', 'thread:C1:1')).toBe('credential:owner:thread:C1:1');
	});
});
