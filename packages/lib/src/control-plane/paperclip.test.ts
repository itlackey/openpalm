import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
		preparePaperclipAddon(homeDir);

		expect(parseEnvFile(paperclipEnvFile(homeDir))).toEqual(first);
		expect(first.BETTER_AUTH_SECRET).toHaveLength(64);
		expect(first.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toHaveLength(64);
		expect(statSync(join(homeDir, 'private', 'env')).mode & 0o777).toBe(0o700);
		expect(statSync(paperclipEnvFile(homeDir)).mode & 0o777).toBe(0o600);
	});

	it('rejects unsupported values instead of passing them into Paperclip', () => {
		const homeDir = createHome();
		mkdirSync(join(homeDir, 'private', 'env'), { recursive: true });
		writeFileSync(paperclipEnvFile(homeDir), 'UNEXPECTED_SECRET=value\n');

		expect(() => preparePaperclipAddon(homeDir)).toThrow(/unsupported key/);
	});
});
