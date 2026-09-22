import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectionDetails } from './connection.js';
import { ensureCredentialKeys } from './credential-store.js';
import { managedComposeFile, stateSecretFile } from './foundation.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

const roots: string[] = [];

function home(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-connection-'));
	roots.push(root);
	mkdirSync(join(root, 'system', 'stack'), { recursive: true });
	mkdirSync(join(root, 'state', 'secrets'), { recursive: true });
	writeFileSync(managedComposeFile(root), 'services: {}\n');
	const config = writeStackConfig(root, defaultStackConfig());
	ensureCredentialKeys(root, config);
	writeFileSync(stateSecretFile(root, 'op_opencode_password'), 'private-password\n');
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared connection details', () => {
	it('keeps native and Guardian secrets hidden unless explicitly requested', () => {
		const root = home();
		const direct = connectionDetails(root, 'opencode');
		expect(direct.username).toBe('opencode');
		expect(direct.password).toBeUndefined();
		expect(connectionDetails(root, 'opencode', { showAssistantPassword: true }).password).toBe(
			'private-password'
		);

		const guarded = connectionDetails(root, 'mcp', { credential: 'owner' });
		expect(guarded.url).toBe('http://127.0.0.1:3830/mcp');
		expect(guarded.credentialKey).toBeUndefined();
		expect(
			connectionDetails(root, 'mcp', {
				credential: 'owner',
				showCredentialKey: true
			}).credentialKey?.length
		).toBeGreaterThanOrEqual(32);
	});
});
