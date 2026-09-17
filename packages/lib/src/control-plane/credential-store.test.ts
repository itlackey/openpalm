import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	credentialKeyFile,
	ensureCredentialKeys,
	readCredentialKey,
	writeCredentialKey
} from './credential-store.js';
import { defaultStackConfig } from './stack-config.js';

const homes: string[] = [];

function home(): string {
	const path = mkdtempSync(join(tmpdir(), 'openpalm-credential-store-'));
	homes.push(path);
	return path;
}

afterEach(() => {
	for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('named credential key store', () => {
	it('migrates legacy built-in keys and generates missing keys', () => {
		const root = home();
		mkdirSync(join(root, 'state', 'secrets'), { recursive: true });
		writeFileSync(join(root, 'state', 'secrets', 'op_guardian_mcp_token'), `${'o'.repeat(40)}\n`);
		const config = defaultStackConfig();
		ensureCredentialKeys(root, config);
		expect(readCredentialKey(root, 'owner')).toBe('o'.repeat(40));
		expect(readCredentialKey(root, 'discord')).toHaveLength(43);
		expect(readFileSync(credentialKeyFile(root, 'slack'), 'utf8').endsWith('\n')).toBe(true);
	});

	it('rejects weak and duplicate keys', () => {
		const root = home();
		expect(() => writeCredentialKey(root, 'owner', 'weak')).toThrow('32–512');
		const config = defaultStackConfig();
		writeCredentialKey(root, 'owner', 'x'.repeat(40));
		writeCredentialKey(root, 'discord', 'x'.repeat(40));
		writeCredentialKey(root, 'slack', 's'.repeat(40));
		expect(() => ensureCredentialKeys(root, config)).toThrow('use the same key');
	});

	it('refuses a credential directory symlink', () => {
		if (process.platform === 'win32') return;
		const root = home();
		const outside = home();
		mkdirSync(join(root, 'state', 'credentials'), { recursive: true });
		writeFileSync(join(outside, 'key'), `${'x'.repeat(40)}\n`);
		symlinkSync(outside, join(root, 'state', 'credentials', 'owner'));
		expect(() => readCredentialKey(root, 'owner')).toThrow('unsafe');
	});
});
