import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import { stateSecretFile, writeFileAtomic } from './lean-foundation.js';
import { isCredentialUsername, type StackConfig } from './stack-config.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEGACY_KEYS: Readonly<Record<string, string>> = {
	owner: 'op_guardian_mcp_token',
	discord: 'portal_discord_secret',
	slack: 'portal_slack_secret'
};

export function credentialStoreDir(homeDir: string): string {
	return join(homeDir, 'state', 'credentials');
}

export function credentialDir(homeDir: string, username: string): string {
	if (!isCredentialUsername(username)) throw new Error(`Invalid credential username: ${username}`);
	return join(credentialStoreDir(homeDir), username);
}

export function credentialKeyFile(homeDir: string, username: string): string {
	return join(credentialDir(homeDir, username), 'key');
}

export function isStrongCredentialKey(value: string): boolean {
	return value.length >= 32 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

export function normalizeCredentialKey(value: string): string {
	const normalized = value.replace(/[\r\n]+$/, '');
	if (!isStrongCredentialKey(normalized)) {
		throw new Error(
			'Credential keys must contain 32–512 printable non-whitespace ASCII characters.'
		);
	}
	return normalized;
}

export function generateCredentialKey(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (!lstatSync(path).isDirectory())
		throw new Error(`Refusing non-directory credential path: ${path}`);
	chmodSync(path, PRIVATE_DIR_MODE);
}

export function writeCredentialKey(homeDir: string, username: string, key: string): string {
	const normalized = normalizeCredentialKey(key);
	const path = credentialKeyFile(homeDir, username);
	ensurePrivateDirectory(dirname(path));
	writeFileAtomic(path, `${normalized}\n`, PRIVATE_FILE_MODE);
	return path;
}

export function readCredentialKey(homeDir: string, username: string): string {
	const directory = credentialDir(homeDir, username);
	if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
		throw new Error(`Credential directory is missing or unsafe: ${directory}`);
	}
	const path = credentialKeyFile(homeDir, username);
	if (!existsSync(path) || !lstatSync(path).isFile()) {
		throw new Error(`Credential key is missing: ${path}`);
	}
	return normalizeCredentialKey(readFileSync(path, 'utf8'));
}

function legacyKey(homeDir: string, username: string): string | null {
	const legacyName = LEGACY_KEYS[username];
	if (!legacyName) return null;
	const path = stateSecretFile(homeDir, legacyName);
	if (!existsSync(path) || !lstatSync(path).isFile()) return null;
	try {
		return normalizeCredentialKey(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

export function ensureCredentialKeys(homeDir: string, config: StackConfig): void {
	ensurePrivateDirectory(credentialStoreDir(homeDir));
	for (const username of Object.keys(config.credentials)) {
		const path = credentialKeyFile(homeDir, username);
		if (existsSync(path)) {
			if (!lstatSync(path).isFile()) throw new Error(`Refusing non-file credential key: ${path}`);
			readCredentialKey(homeDir, username);
			chmodSync(path, PRIVATE_FILE_MODE);
			continue;
		}
		writeCredentialKey(homeDir, username, legacyKey(homeDir, username) ?? generateCredentialKey());
	}

	const seen = new Map<string, string>();
	for (const username of Object.keys(config.credentials)) {
		const key = readCredentialKey(homeDir, username);
		const duplicate = seen.get(key);
		if (duplicate) {
			throw new Error(`Credentials ${duplicate} and ${username} use the same key.`);
		}
		seen.set(key, username);
	}
}

export function removeCredentialKey(homeDir: string, username: string): void {
	const path = credentialKeyFile(homeDir, username);
	if (existsSync(path)) {
		if (!lstatSync(path).isFile()) throw new Error(`Refusing non-file credential key: ${path}`);
		unlinkSync(path);
	}
	const directory = credentialDir(homeDir, username);
	if (existsSync(directory)) {
		if (!lstatSync(directory).isDirectory()) {
			throw new Error(`Refusing non-directory credential path: ${directory}`);
		}
		if (readdirSync(directory).length === 0) rmdirSync(directory);
	}
}
