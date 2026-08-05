import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './crypto.js';
import { parseEnvFile, quoteEnvValue } from './env.js';
import { writeFileAtomic } from './fs-atomic.js';
import { privateDir } from './home.js';

const PAPERCLIP_ENV_KEYS = ['BETTER_AUTH_SECRET', 'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET'] as const;

/**
 * The pinned upstream `paperclipai` npm release this stack packages.
 *
 * SINGLE SOURCE OF TRUTH. The same version is repeated in three files that
 * cannot import TypeScript — the Dockerfile's `ARG PAPERCLIP_VERSION`, the
 * Compose default `${OP_PAPERCLIP_VERSION:-…}`, and the addon env schema —
 * so `paperclip-image-contract.test.ts` asserts all three agree with this
 * constant. Bump here first; the test names any file left behind.
 */
export const PAPERCLIP_UPSTREAM_VERSION = '2026.722.0';

export function paperclipEnvFile(homeDir: string): string {
	return join(privateDir(homeDir), 'env', 'paperclip.env');
}

/** Seed Paperclip's upstream-required environment before generic addon enable. */
export function preparePaperclipAddon(homeDir: string): void {
	const envDir = join(privateDir(homeDir), 'env');
	const envPath = paperclipEnvFile(homeDir);
	mkdirSync(envDir, { recursive: true, mode: 0o700 });
	chmodSync(envDir, 0o700);

	const existingEnv = existsSync(envPath) ? parseEnvFile(envPath) : {};
	const unknown = Object.keys(existingEnv).filter(
		(key) => !PAPERCLIP_ENV_KEYS.includes(key as (typeof PAPERCLIP_ENV_KEYS)[number])
	);
	if (unknown.length > 0) {
		throw new Error(`Paperclip env contains unsupported key(s): ${unknown.join(', ')}`);
	}

	const betterAuth = existingEnv.BETTER_AUTH_SECRET || randomHex(32);
	const signing = existingEnv.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET || randomHex(32);

	writeFileAtomic(
		envPath,
		[
			`BETTER_AUTH_SECRET=${quoteEnvValue(betterAuth)}`,
			`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=${quoteEnvValue(signing)}`,
			''
		].join('\n'),
		0o600
	);
	chmodSync(envPath, 0o600);
}
