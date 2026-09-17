import { lstatSync, readFileSync, statSync } from 'node:fs';

const BUNDLE_VERSION = 1;
const MAX_BUNDLE_BYTES = 1_048_576;
const MAX_CREDENTIALS = 128;
const MAX_USER_MAPPINGS = 10_000;
const USERNAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export type PortalAdapter = 'discord' | 'slack';
export type PortalCredential = { username: string; key: string };

type CredentialBundle = {
	default: string;
	users: Record<string, string>;
	credentials: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function validUsername(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		USERNAME_RE.test(value) &&
		value !== 'constructor' &&
		value !== 'prototype'
	);
}

function validCredentialKey(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 32 &&
		value.length <= 512 &&
		/^[\x21-\x7e]+$/.test(value)
	);
}

function validUserId(adapter: PortalAdapter, value: string): boolean {
	return adapter === 'discord' ? /^[0-9]{5,32}$/.test(value) : /^[A-Z][A-Z0-9]{2,31}$/.test(value);
}

export function parseCredentialBundle(adapter: PortalAdapter, value: unknown): CredentialBundle {
	const root = asRecord(value);
	if (
		!root ||
		root.version !== BUNDLE_VERSION ||
		!hasOnlyKeys(root, ['version', 'default', 'users', 'credentials'])
	) {
		throw new Error(`Portal credential bundle must use version ${BUNDLE_VERSION}`);
	}
	if (!validUsername(root.default)) throw new Error('Portal default credential is invalid');
	const rawUsers = asRecord(root.users);
	const rawCredentials = asRecord(root.credentials);
	if (!rawUsers || !rawCredentials) throw new Error('Portal credential bundle is incomplete');
	if (Object.keys(rawUsers).length > MAX_USER_MAPPINGS) {
		throw new Error(`Portal credential bundle exceeds ${MAX_USER_MAPPINGS} users`);
	}
	if (
		Object.keys(rawCredentials).length < 1 ||
		Object.keys(rawCredentials).length > MAX_CREDENTIALS
	) {
		throw new Error(`Portal credential bundle must contain 1-${MAX_CREDENTIALS} credentials`);
	}

	const credentials: Record<string, string> = {};
	for (const [username, key] of Object.entries(rawCredentials)) {
		if (!validUsername(username) || !validCredentialKey(key)) {
			throw new Error(`Portal credential ${username} is invalid`);
		}
		credentials[username] = key;
	}
	if (!Object.hasOwn(credentials, root.default)) {
		throw new Error('Portal default credential key is missing');
	}

	const users: Record<string, string> = {};
	for (const [userId, username] of Object.entries(rawUsers)) {
		if (!validUserId(adapter, userId)) throw new Error(`Invalid ${adapter} user ID: ${userId}`);
		if (!validUsername(username) || !Object.hasOwn(credentials, username)) {
			throw new Error(`${adapter} user ${userId} references an unavailable credential`);
		}
		users[userId] = username;
	}
	return { default: root.default, users, credentials };
}

export function credentialConversationKey(username: string, platformKey: string): string {
	if (!validUsername(username)) throw new Error('Invalid conversation credential');
	return `credential:${username}:${platformKey}`;
}

export class PortalCredentialRegistry {
	constructor(
		private readonly adapter: PortalAdapter,
		private readonly path = Bun.env.PORTAL_CREDENTIALS_FILE ?? ''
	) {
		if (!path) throw new Error('PORTAL_CREDENTIALS_FILE is required');
	}

	private read(): CredentialBundle {
		try {
			if (!lstatSync(this.path).isFile()) throw new Error('not a regular file');
			if (statSync(this.path).size > MAX_BUNDLE_BYTES) {
				throw new Error(`exceeds ${MAX_BUNDLE_BYTES} bytes`);
			}
			return parseCredentialBundle(
				this.adapter,
				JSON.parse(readFileSync(this.path, 'utf8')) as unknown
			);
		} catch (error) {
			throw new Error(
				`Portal credential bundle is not usable: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	defaultCredential(): PortalCredential {
		return this.resolveFrom(this.read(), undefined);
	}

	forUser(userId: string): PortalCredential {
		if (!validUserId(this.adapter, userId)) throw new Error(`Invalid ${this.adapter} user ID`);
		return this.resolveFrom(this.read(), userId);
	}

	private resolveFrom(bundle: CredentialBundle, userId: string | undefined): PortalCredential {
		const username = (userId && bundle.users[userId]) || bundle.default;
		const key = bundle.credentials[username];
		if (!key) throw new Error('Selected portal credential is unavailable');
		return { username, key };
	}
}
