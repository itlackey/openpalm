import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './crypto.js';
import { parseEnvFile, quoteEnvValue } from './env.js';
import { writeFileAtomic } from './fs-atomic.js';
import { privateDir } from './home.js';

/**
 * The upstream-required keys Paperclip reads from `process.env` only (no
 * `*_FILE` indirection), which is why they live in an env file at all.
 *
 * Exported because `secret-audit.ts` audits exactly what this module writes.
 * Two private copies would diverge silently: adding a third key here would
 * make the auditor reject the file this writer just produced.
 */
export const PAPERCLIP_ENV_KEYS: ReadonlySet<string> = new Set([
	'BETTER_AUTH_SECRET',
	'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET'
]);

/**
 * The pinned upstream `paperclipai` npm release this stack packages.
 *
 * Authoritative for the TypeScript side. Three files that cannot import
 * TypeScript repeat it — the Dockerfile's `ARG PAPERCLIP_VERSION`, the Compose
 * default `${OP_PAPERCLIP_VERSION:-…}`, and the addon env schema — and
 * `paperclip-image-contract.test.ts` fails if any of them drifts from this
 * constant. Bump here first; the test names whichever file was left behind.
 */
export const PAPERCLIP_UPSTREAM_VERSION = '2026.722.0';

export function paperclipEnvFile(homeDir: string): string {
	return join(privateDir(homeDir), 'env', 'paperclip.env');
}

/**
 * Seed Paperclip's upstream-required environment.
 *
 * Idempotent and seed-if-missing: existing secret values are preserved, so a
 * re-run never rotates `BETTER_AUTH_SECRET` (which would invalidate every
 * Paperclip session). Writes only when a value was actually generated.
 */
export function preparePaperclipAddon(homeDir: string): void {
	const envDir = join(privateDir(homeDir), 'env');
	const envPath = paperclipEnvFile(homeDir);
	// `mode` on create closes the window where the dir exists as 0755; the
	// chmod is the repair path, since mkdirSync ignores mode on an existing dir.
	mkdirSync(envDir, { recursive: true, mode: 0o700 });
	chmodSync(envDir, 0o700);

	// parseEnvFile already returns {} for a missing file.
	const existingEnv = parseEnvFile(envPath);
	const unknown = Object.keys(existingEnv).filter((key) => !PAPERCLIP_ENV_KEYS.has(key));
	if (unknown.length > 0) {
		throw new Error(`Paperclip env contains unsupported key(s): ${unknown.join(', ')}`);
	}

	const betterAuth = existingEnv.BETTER_AUTH_SECRET || randomHex(32);
	const signing = existingEnv.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET || randomHex(32);

	// Nothing generated and nothing missing ⇒ the file is already correct.
	// Skip the rewrite so a no-op enable does not churn the file's inode.
	if (existingEnv.BETTER_AUTH_SECRET && existingEnv.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET) {
		return;
	}

	writeFileAtomic(
		envPath,
		[
			`BETTER_AUTH_SECRET=${quoteEnvValue(betterAuth)}`,
			`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=${quoteEnvValue(signing)}`,
			''
		].join('\n'),
		0o600
	);
	// writeFileSync does not re-apply mode to a pre-existing `${path}.tmp` left
	// by a crash between write and rename — matches secrets-files.ts:137.
	chmodSync(envPath, 0o600);
}
