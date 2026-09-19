import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	authenticateCredential,
	bearerToken,
	findCredentialByUsername,
	guardianPolicyAgent,
	loadCredentialRegistry,
	readHandleKey
} from './credentials.js';

const directories: string[] = [];
const original = {
	auth: Bun.env.GUARDIAN_AUTH_DIR,
	handle: Bun.env.GUARDIAN_HANDLE_KEY_FILE
};

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), 'openpalm-credentials-'));
	directories.push(path);
	return path;
}

function configure(
	records: Array<{ username: string; id: string; policy: 'chat' | 'read' | 'full'; key: string }>
): string {
	const root = directory();
	for (const record of records) {
		const path = join(root, record.username);
		mkdirSync(path, { mode: 0o700 });
		writeFileSync(join(path, 'key'), `${record.key}\n`, { mode: 0o600 });
	}
	writeFileSync(
		join(root, 'registry.json'),
		JSON.stringify({
			version: 1,
			credentials: records.map(({ key: _key, ...record }) => record)
		})
	);
	Bun.env.GUARDIAN_AUTH_DIR = root;
	return root;
}

afterEach(() => {
	for (const [key, value] of [
		['GUARDIAN_AUTH_DIR', original.auth],
		['GUARDIAN_HANDLE_KEY_FILE', original.handle]
	] as const) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Guardian bearer credentials', () => {
	it('authenticates a named credential with its identity and policy', () => {
		configure([
			{ username: 'owner', id: 'owner', policy: 'full', key: 'o'.repeat(32) },
			{
				username: 'build-bot',
				id: `cred_${'a'.repeat(32)}`,
				policy: 'read',
				key: 'b'.repeat(32)
			}
		]);
		expect(
			authenticateCredential(
				new Request('http://guardian/mcp', {
					headers: { authorization: `Bearer ${'b'.repeat(32)}` }
				})
			)
		).toEqual({
			username: 'build-bot',
			id: `cred_${'a'.repeat(32)}`,
			policy: 'read'
		});
		expect(
			authenticateCredential(
				new Request('http://guardian/mcp', {
					headers: { authorization: `Basic ${'b'.repeat(32)}` }
				})
			)
		).toBeNull();
		expect(bearerToken(new Request('http://guardian/mcp'))).toBe('');
		expect(findCredentialByUsername('build-bot')).toEqual({
			username: 'build-bot',
			id: `cred_${'a'.repeat(32)}`,
			policy: 'read'
		});
		expect(findCredentialByUsername('missing')).toBeNull();
	});

	it('rejects weak, duplicated, malformed, and missing credential records', () => {
		configure([
			{ username: 'owner', id: 'owner', policy: 'full', key: 'same'.repeat(8) },
			{ username: 'discord', id: 'discord', policy: 'chat', key: 'same'.repeat(8) }
		]);
		expect(
			authenticateCredential(
				new Request('http://guardian/mcp', {
					headers: { authorization: `Bearer ${'same'.repeat(8)}` }
				})
			)
		).toBeNull();

		const root = directory();
		writeFileSync(join(root, 'registry.json'), '{"version":1,"credentials":[]}');
		Bun.env.GUARDIAN_AUTH_DIR = root;
		expect(() => loadCredentialRegistry()).toThrow('invalid credential count');
		expect(
			authenticateCredential(
				new Request('http://guardian/mcp', {
					headers: { authorization: `Bearer ${'x'.repeat(32)}` }
				})
			)
		).toBeNull();
	});

	it('loads only a strong handle encryption key', () => {
		const root = directory();
		const handle = join(root, 'handle');
		writeFileSync(handle, `${'h'.repeat(64)}\n`, { mode: 0o600 });
		Bun.env.GUARDIAN_HANDLE_KEY_FILE = handle;
		expect(readHandleKey()).toBe('h'.repeat(64));
		writeFileSync(handle, 'weak\n', { mode: 0o600 });
		expect(readHandleKey()).toBe('');
	});

	it('maps policies to fixed managed agent profiles', () => {
		expect(guardianPolicyAgent('chat')).toBe('remote');
		expect(guardianPolicyAgent('read')).toBe('remote-read');
		expect(guardianPolicyAgent('full')).toBe('remote-full');
	});
});
