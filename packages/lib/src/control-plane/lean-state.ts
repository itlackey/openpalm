import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
	createLeanState,
	ensureLeanDirs,
	managedComposeFile,
	readEnvFile,
	resolveOpenPalmHome,
	stackConfigFile,
	stackEnvFile,
	stateSecretFile,
	updateEnvFile,
	writeFileAtomic,
	type LeanState
} from './lean-foundation.js';
import { ensureCredentialKeys } from './credential-store.js';
import { ensureOAuthFiles } from './oauth-store.js';
import { syncPortalCredentialBundles } from './portal-credential-store.js';
import { ensureStackConfig } from './stack-config.js';

const PRIVATE_FILE_MODE = 0o600;

export type LeanInstallState = 'not_installed' | 'incompatible_home' | 'setup_incomplete' | 'installed';

export { createLeanState };

export function readLeanStackEnv(homeDir: string): Record<string, string> {
	return readEnvFile(stackEnvFile(homeDir));
}

export function classifyLeanInstall(homeDir = resolveOpenPalmHome()): LeanInstallState {
	if (!existsSync(homeDir)) return 'not_installed';
	if (!lstatSync(homeDir).isDirectory()) return 'incompatible_home';
	const env = readLeanStackEnv(homeDir);
	const hasLeanStack = existsSync(managedComposeFile(homeDir));
	if (!hasLeanStack) return readdirSync(homeDir).length === 0 ? 'not_installed' : 'incompatible_home';
	if (!existsSync(stackConfigFile(homeDir))) return 'setup_incomplete';
	return env.OP_SETUP_COMPLETE === 'true' ? 'installed' : 'setup_incomplete';
}

export function requireLeanInstall(homeDir = resolveOpenPalmHome()): void {
	const state = classifyLeanInstall(homeDir);
	if (state === 'not_installed') {
		throw new Error(`OpenPalm is not installed at ${homeDir}. Run \`openpalm install\` first.`);
	}
	if (state === 'incompatible_home') {
		throw new Error(
			`Refusing incompatible or legacy OpenPalm home at ${homeDir}. Install 0.14 into an empty OP_HOME, then use \`openpalm import\`.`
		);
	}
}

function validId(value: string | undefined): number | null {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function operatorIds(
	homeDir: string,
	current: Record<string, string>
): { uid: number; gid: number } | null {
	if (process.platform === 'win32') return null;
	const pinnedUid = validId(current.OP_UID);
	const pinnedGid = validId(current.OP_GID);
	if (pinnedUid !== null && pinnedGid !== null) return { uid: pinnedUid, gid: pinnedGid };

	let disk: { uid: number; gid: number } | null = null;
	try {
		const stat = statSync(homeDir);
		disk = { uid: stat.uid, gid: stat.gid };
	} catch {
		// A first install may not have created OP_HOME yet.
	}
	const processUid = process.getuid?.();
	const processGid = process.getgid?.();
	const uid = disk && disk.uid !== 0 ? disk.uid : (processUid ?? disk?.uid);
	const gid = disk && disk.gid !== 0 ? disk.gid : (processGid ?? disk?.gid);
	if (uid === undefined || gid === undefined) return null;
	if (uid === 0 || gid === 0) {
		throw new Error(
			'Refusing to run managed containers as root. Install and operate OpenPalm with a non-root account.'
		);
	}
	return { uid, gid };
}

function ensureStackEnv(state: LeanState): void {
	const path = stackEnvFile(state.homeDir);
	const current = readEnvFile(path);
	const ids = operatorIds(state.homeDir, current);
	const updates: Record<string, string> = {
		OP_HOME: state.homeDir,
		OP_IMAGE_NAMESPACE: process.env.OP_IMAGE_NAMESPACE?.trim() || 'openpalm',
		OP_HOST_ENABLED: 'true',
		OP_SETUP_COMPLETE: current.OP_SETUP_COMPLETE === 'true' ? 'true' : 'false'
	};
	if (ids) {
		updates.OP_UID = String(ids.uid);
		updates.OP_GID = String(ids.gid);
	}
	updateEnvFile(path, updates);
}

function ensureRegularFile(path: string, initialValue: string): void {
	if (existsSync(path)) {
		if (!lstatSync(path).isFile()) throw new Error(`Refusing to replace non-file path: ${path}`);
		chmodSync(path, PRIVATE_FILE_MODE);
		return;
	}
	writeFileAtomic(path, initialValue, PRIVATE_FILE_MODE);
}

function randomSecret(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

function ensureLeanSecrets(homeDir: string): void {
	for (const name of ['op_opencode_password', 'op_guardian_handle_key']) {
		ensureRegularFile(stateSecretFile(homeDir, name), `${randomSecret()}\n`);
	}
	for (const name of ['discord_bot_token', 'slack_bot_token', 'slack_app_token']) {
		ensureRegularFile(stateSecretFile(homeDir, name), '\n');
	}
}

export function ensureLeanRuntime(state: LeanState): void {
	ensureLeanDirs(state.homeDir);
	const composePath = managedComposeFile(state.homeDir);
	if (!existsSync(composePath)) throw new Error(`Managed stack file is missing: ${composePath}`);
	ensureStackEnv(state);
	const config = ensureStackConfig(state.homeDir);
	ensureCredentialKeys(state.homeDir, config);
	ensureOAuthFiles(state.homeDir);
	syncPortalCredentialBundles(state.homeDir, config);
	ensureRegularFile(join(state.homeDir, 'knowledge', 'secrets', 'auth.json'), '{}\n');
	ensureRegularFile(join(state.homeDir, 'knowledge', 'env', 'user.env'), '');
	ensureLeanSecrets(state.homeDir);
}

export function markLeanInstalled(homeDir: string): void {
	updateEnvFile(stackEnvFile(homeDir), {
		OP_HOST_ENABLED: 'true',
		OP_SETUP_COMPLETE: 'true'
	});
}

export function readManagedStack(state: LeanState): string {
	return readFileSync(managedComposeFile(state.homeDir), 'utf8');
}
