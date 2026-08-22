import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './crypto.js';
import { parseEnvFile, quoteEnvValue } from './env.js';
import { writeFileAtomic } from './fs-atomic.js';
import { stateEnvDir } from './home.js';

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
	'PAPERCLIP_AGENT_JWT_SECRET'
]);

const LEGACY_PAPERCLIP_SIGNING_KEY = 'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET';

export function paperclipEnvFile(homeDir: string): string {
	return join(stateEnvDir(homeDir), 'paperclip.env');
}

/**
 * Seed Paperclip's upstream-required environment.
 *
 * Idempotent and seed-if-missing: existing secret values are preserved, so a
 * re-run never rotates `BETTER_AUTH_SECRET` (which would invalidate every
 * Paperclip session). Writes only when a value was actually generated.
 *
 * The strict unknown-key boundary is enforced only while the addon is
 * `enabled` (the default): ensureSecrets seeds this file unconditionally
 * (compose config fails on a missing env_file), and a stray key in a file
 * for a DISABLED addon must not abort every install/update/deploy. When
 * disabled, unknown keys are preserved untouched and the throw is skipped —
 * the secret audit still enforces the boundary at activation once the addon
 * is enabled.
 */
export function preparePaperclipAddon(homeDir: string, opts: { enabled?: boolean } = {}): void {
	const enabled = opts.enabled ?? true;
	const envDir = stateEnvDir(homeDir);
	const envPath = paperclipEnvFile(homeDir);
	// `mode` on create closes the window where the dir exists as 0755; the
	// chmod is the repair path, since mkdirSync ignores mode on an existing dir.
	mkdirSync(envDir, { recursive: true, mode: 0o700 });
	chmodSync(envDir, 0o700);

	// parseEnvFile already returns {} for a missing file.
	const existingEnv = parseEnvFile(envPath);
	const unknown = Object.keys(existingEnv).filter(
		(key) => !PAPERCLIP_ENV_KEYS.has(key) && key !== LEGACY_PAPERCLIP_SIGNING_KEY
	);
	if (unknown.length > 0 && enabled) {
		throw new Error(`Paperclip env ${envPath} contains unsupported key(s): ${unknown.join(', ')}`);
	}

	const betterAuth = existingEnv.BETTER_AUTH_SECRET || randomHex(32);
	// Early Paperclip addon builds seeded an upstream key that this pinned image
	// does not use. Reuse that entropy rather than rotating persisted state.
	const agentJwt =
		existingEnv.PAPERCLIP_AGENT_JWT_SECRET ||
		existingEnv[LEGACY_PAPERCLIP_SIGNING_KEY] ||
		randomHex(32);

	// Nothing generated and nothing missing ⇒ the file is already correct.
	// Skip the rewrite so a no-op enable does not churn the file's inode.
	if (
		existingEnv.BETTER_AUTH_SECRET &&
		existingEnv.PAPERCLIP_AGENT_JWT_SECRET &&
		!(LEGACY_PAPERCLIP_SIGNING_KEY in existingEnv)
	) {
		chmodSync(envPath, 0o600);
		return;
	}

	writeFileAtomic(
		envPath,
		[
			// Disabled addon only (`unknown` is empty otherwise — see the throw
			// above): unknown keys ride along untouched rather than being dropped
			// by the rewrite.
			...unknown.map((key) => `${key}=${quoteEnvValue(existingEnv[key] ?? '')}`),
			`BETTER_AUTH_SECRET=${quoteEnvValue(betterAuth)}`,
			`PAPERCLIP_AGENT_JWT_SECRET=${quoteEnvValue(agentJwt)}`,
			''
		].join('\n'),
		0o600
	);
	// writeFileSync does not re-apply mode to a pre-existing `${path}.tmp` left
	// by a crash between write and rename — matches secrets-files.ts:137.
	chmodSync(envPath, 0o600);
}

export function migrateLegacyPaperclipEnv(homeDir: string): boolean {
	const existingEnv = parseEnvFile(paperclipEnvFile(homeDir));
	if (!(LEGACY_PAPERCLIP_SIGNING_KEY in existingEnv)) return false;
	preparePaperclipAddon(homeDir);
	return true;
}
