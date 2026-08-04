/**
 * Shared reset helpers for the two setup-wizard e2e suites.
 *
 * Resets just enough state on disk that `isSetupComplete()` in
 * hooks.server.ts returns false and the wizard re-runs end-to-end:
 *   - backs up stack.env (caller restores after the test via
 *     restoreWizardState)
 *   - rewrites state/stack.env with OP_SETUP_COMPLETE=false (and keeps
 *     OP_HOST_ENABLED=true — these fixtures exercise the wizard, which only
 *     applies to a machine that hosts a stack) so state
 *     overrides any legacy true value still present in state/stack.env
 *   - removes any persisted voice profile selection so the wizard
 *     starts from a known blank state
 *
 * Does NOT tear down running containers — those are reused so each
 * test doesn't have to wait for fresh image pulls. The wizard's deploy
 * step is idempotent against an already-running stack (compose up is a
 * no-op when containers are already healthy).
 *
 * IMPORTANT: only points at the dev-stack OP_HOME (default `.dev`).
 * Refuses to touch a path that contains `.openpalm` so a misconfigured
 * test can't nuke a developer's production install.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

export function resolveOpHome(): string {
	return process.env.OP_HOME ?? resolve(REPO_ROOT, '.dev');
}

function stateEnvPath(homeDir: string): string {
	return resolve(homeDir, 'state/stack.env');
}

function backupPath(homeDir: string): string {
	return resolve(homeDir, 'state/stack.env.wizard-test-backup');
}

function assertSafeHome(homeDir: string): void {
	const name = basename(homeDir);
	if (name === '.openpalm' || homeDir.includes('/.openpalm')) {
		throw new Error(
			`wizard-reset refuses to touch a production OP_HOME (${homeDir}). ` +
				`Set OP_HOME to a dev-only directory (default .dev) before running these tests.`,
		);
	}
}

/**
 * Capture the current state env to a sibling backup file and rewrite it so the
 * next isSetupComplete() check returns false. Idempotent — calling it twice
 * without restore in between only backs up once.
 */
export function resetWizardState(homeDir: string = resolveOpHome()): void {
	assertSafeHome(homeDir);
	const envPath = stateEnvPath(homeDir);
	const bak = backupPath(homeDir);
	if (!existsSync(envPath)) {
		throw new Error(`state env not found at ${envPath}; the dev stack must be set up first.`);
	}

	// First reset wins: backup only if no backup yet.
	if (!existsSync(bak)) copyFileSync(envPath, bak);

	const current = readFileSync(envPath, 'utf-8');
	const stripped = current
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith('OP_SETUP_COMPLETE=')) return false;
			// A "reset" that leaves the host record behind is not a first run:
			// the landing would still take the host rows and the wizard would
			// still be forced, so the suite would silently test the wrong thing.
			if (trimmed.startsWith('OP_HOST_ENABLED=')) return false;
			if (trimmed.startsWith('OP_VOICE_PROFILE=')) return false;
			return true;
		})
		.filter(Boolean)
		.join('\n');
	const next = `${stripped ? `${stripped}\n` : ''}OP_SETUP_COMPLETE=false\nOP_HOST_ENABLED=true\n`;

	// Note: writeFileSync changes inode. The setup wizard isn't running
	// inside a container; the UI server reads stack.env via Node fs each
	// time isSetupComplete() is called, so a new inode is fine here.
	writeFileSync(envPath, next, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Restore the pre-reset stack.env. Safe to call from afterAll even if
 * resetWizardState was never invoked (no-op when backup is missing).
 */
export function restoreWizardState(homeDir: string = resolveOpHome()): void {
	assertSafeHome(homeDir);
	const envPath = stateEnvPath(homeDir);
	const bak = backupPath(homeDir);
	if (!existsSync(bak)) return;
	copyFileSync(bak, envPath);
	unlinkSync(bak);
}

/**
 * The minimum-viable setup payload — no providers, browser-only voice,
 * allow-empty-install enabled. Exercises the full performSetup path
 * + deploy without depending on any cloud credentials or pulling the
 * 2.4 GB voice image.
 */
export function minimalSetupPayload(uiPassword = 'wizard-e2e-test-password'): Record<string, unknown> {
	return {
		version: 2,
		security: { uiLoginPassword: uiPassword },
		connections: [],
		// Browser-only voice — no openpalm/voice container, no addon enable.
		tts: { enabled: true, engine: 'browser-tts' },
		stt: { enabled: true, engine: 'browser-stt' },
		addons: {},
	};
}
