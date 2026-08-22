import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from './env.js';
import { paperclipEnvFile, preparePaperclipAddon } from './paperclip.js';

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createHome(): string {
	const homeDir = mkdtempSync(join(tmpdir(), 'paperclip-addon-'));
	tempDirs.push(homeDir);
	return homeDir;
}

describe('preparePaperclipAddon', () => {
	it('seeds and preserves the two upstream-required secrets', () => {
		const homeDir = createHome();
		preparePaperclipAddon(homeDir);
		const first = parseEnvFile(paperclipEnvFile(homeDir));
		chmodSync(paperclipEnvFile(homeDir), 0o644);
		preparePaperclipAddon(homeDir);

		expect(parseEnvFile(paperclipEnvFile(homeDir))).toEqual(first);
		expect(first.BETTER_AUTH_SECRET).toHaveLength(64);
		expect(first.PAPERCLIP_AGENT_JWT_SECRET).toHaveLength(64);
		expect(statSync(join(homeDir, 'state', 'env')).mode & 0o777).toBe(0o700);
		expect(statSync(paperclipEnvFile(homeDir)).mode & 0o777).toBe(0o600);
	});

	it('migrates the unused legacy signing key without rotating its value', () => {
		const homeDir = createHome();
		mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
		writeFileSync(
			paperclipEnvFile(homeDir),
			'BETTER_AUTH_SECRET=auth\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=legacy-signing\n'
		);

		preparePaperclipAddon(homeDir);

		expect(parseEnvFile(paperclipEnvFile(homeDir))).toEqual({
			BETTER_AUTH_SECRET: 'auth',
			PAPERCLIP_AGENT_JWT_SECRET: 'legacy-signing'
		});
	});

	it('rejects unsupported values instead of passing them into Paperclip', () => {
		const homeDir = createHome();
		mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
		writeFileSync(paperclipEnvFile(homeDir), 'UNEXPECTED_SECRET=value\n');

		expect(() => preparePaperclipAddon(homeDir)).toThrow(/unsupported key/);
	});

	it('names the env file path in the unsupported-key error', () => {
		const homeDir = createHome();
		mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
		writeFileSync(paperclipEnvFile(homeDir), 'UNEXPECTED_SECRET=value\n');

		expect(() => preparePaperclipAddon(homeDir, { enabled: true })).toThrow(
			paperclipEnvFile(homeDir)
		);
	});

	it('does not throw for unknown keys when the addon is disabled — seeds and preserves them', () => {
		const homeDir = createHome();
		mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
		writeFileSync(paperclipEnvFile(homeDir), 'UNEXPECTED_SECRET=value\n');

		preparePaperclipAddon(homeDir, { enabled: false });

		const env = parseEnvFile(paperclipEnvFile(homeDir));
		// The stray key survives untouched (audit enforces the boundary at
		// activation once the addon is enabled), and the required secrets are
		// still seeded so compose config never fails on the env_file.
		expect(env.UNEXPECTED_SECRET).toBe('value');
		expect(env.BETTER_AUTH_SECRET).toHaveLength(64);
		expect(env.PAPERCLIP_AGENT_JWT_SECRET).toHaveLength(64);
	});

	it('leaves a complete file with unknown keys untouched when the addon is disabled', () => {
		const homeDir = createHome();
		mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
		writeFileSync(
			paperclipEnvFile(homeDir),
			'BETTER_AUTH_SECRET=auth\nPAPERCLIP_AGENT_JWT_SECRET=jwt\nUNEXPECTED_SECRET=value\n'
		);

		preparePaperclipAddon(homeDir, { enabled: false });

		expect(parseEnvFile(paperclipEnvFile(homeDir))).toEqual({
			BETTER_AUTH_SECRET: 'auth',
			PAPERCLIP_AGENT_JWT_SECRET: 'jwt',
			UNEXPECTED_SECRET: 'value'
		});
	});
});
