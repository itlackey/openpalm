import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { constantTimeEqual } from './crypto.js';

export type GuardianPolicy = 'chat' | 'read' | 'full';
export type CredentialClass = string;
export type AuthenticatedCredential = {
	id: string;
	username: string;
	policy: GuardianPolicy;
};

const MAX_CREDENTIALS = 128;
const MAX_REGISTRY_BYTES = 64 * 1024;
const USERNAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const CREDENTIAL_ID_RE = /^(?:owner|discord|slack|cred_[a-f0-9]{32})$/;
const POLICY_AGENTS: Readonly<Record<GuardianPolicy, string>> = {
	chat: 'remote',
	read: 'remote-read',
	full: 'remote-full'
};

export function isCredentialUsername(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		USERNAME_RE.test(value) &&
		value !== 'constructor' &&
		value !== 'prototype'
	);
}

export function isCredentialId(value: unknown): value is string {
	return typeof value === 'string' && CREDENTIAL_ID_RE.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function readToken(path: string | undefined): string {
	if (!path) return '';
	try {
		if (!lstatSync(path).isFile()) return '';
		return readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
	} catch {
		return '';
	}
}

function isStrongToken(value: string): boolean {
	return value.length >= 32 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

export function bearerToken(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	const match = header.match(/^Bearer\s+([^\s]+)$/i);
	return match?.[1] ?? '';
}

export function loadCredentialRegistry(
	directory = Bun.env.GUARDIAN_AUTH_DIR ?? ''
): ReadonlyArray<AuthenticatedCredential & { key: string }> {
	if (!directory) throw new Error('Guardian credential directory is not configured');
	const registryPath = join(directory, 'registry.json');
	const registryStat = lstatSync(registryPath);
	if (!registryStat.isFile() || registryStat.size > MAX_REGISTRY_BYTES) {
		throw new Error('Guardian credential registry is invalid');
	}
	const root = asRecord(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
	if (!root || !exactKeys(root, ['version', 'credentials']) || root.version !== 1) {
		throw new Error('Guardian credential registry has an unsupported shape');
	}
	if (
		!Array.isArray(root.credentials) ||
		root.credentials.length < 1 ||
		root.credentials.length > MAX_CREDENTIALS
	) {
		throw new Error('Guardian credential registry has an invalid credential count');
	}

	const usernames = new Set<string>();
	const ids = new Set<string>();
	const keys = new Set<string>();
	const credentials: Array<AuthenticatedCredential & { key: string }> = [];
	for (const raw of root.credentials) {
		const item = asRecord(raw);
		if (!item || !exactKeys(item, ['username', 'id', 'policy'])) {
			throw new Error('Guardian credential registry contains an invalid record');
		}
		const { username, id, policy } = item;
		if (
			!isCredentialUsername(username) ||
			!isCredentialId(id) ||
			(policy !== 'chat' && policy !== 'read' && policy !== 'full')
		) {
			throw new Error('Guardian credential registry contains an invalid identity');
		}
		const credentialDirectory = join(directory, username);
		if (!lstatSync(credentialDirectory).isDirectory()) {
			throw new Error(`Guardian credential directory is invalid for ${username}`);
		}
		const key = readToken(join(credentialDirectory, 'key'));
		if (!isStrongToken(key)) throw new Error(`Guardian credential key is invalid for ${username}`);
		if (usernames.has(username) || ids.has(id) || keys.has(key)) {
			throw new Error('Guardian credential registry contains a duplicate identity or key');
		}
		usernames.add(username);
		ids.add(id);
		keys.add(key);
		credentials.push({ username, id, policy, key });
	}
	return credentials;
}

export function authenticateCredential(request: Request): AuthenticatedCredential | null {
	const presented = bearerToken(request);
	if (!presented) return null;

	let matched: AuthenticatedCredential | null = null;
	let matches = 0;
	try {
		for (const candidate of loadCredentialRegistry()) {
			// Compare every configured key so registry order does not create an
			// observable early-return timing signal.
			if (constantTimeEqual(presented, candidate.key)) {
				matched = {
					id: candidate.id,
					username: candidate.username,
					policy: candidate.policy
				};
				matches += 1;
			}
		}
	} catch {
		// A malformed or incomplete registry fails closed for every credential.
		return null;
	}
	return matches === 1 ? matched : null;
}

export function findCredentialByUsername(
	username: string,
	directory = Bun.env.GUARDIAN_AUTH_DIR ?? ''
): AuthenticatedCredential | null {
	try {
		const matched = loadCredentialRegistry(directory).filter(
			(candidate) => candidate.username === username
		);
		if (matched.length !== 1) return null;
		const [{ id, policy }] = matched;
		return { id, username, policy };
	} catch {
		return null;
	}
}

export function readHandleKey(): string {
	const key = readToken(Bun.env.GUARDIAN_HANDLE_KEY_FILE);
	return isStrongToken(key) ? key : '';
}

export function guardianPolicyAgent(policy: GuardianPolicy): string {
	return POLICY_AGENTS[policy];
}
